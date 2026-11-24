import type { Bot, OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  quietSlots: 6,
  minSellerSol: 4,
  holdSlots: 96,
  takeProfit: 0.18,
  stopLoss: 0.09,
  riskSol: 0.75,
  buySlippageBps: 200,
};

type Params = typeof DEFAULT_PARAMS;
const SOL = 1_000_000_000;
const MIN_ROUND_TRIP = 10_001_000n;
// Allow for integer rounding when the curve converts the buy budget to tokens.
const COVER_BUDGET = MIN_ROUND_TRIP + 2n;
const COVER_TARGET = 21;
const MIN_COVER_AGE = 32;
const MAX_ALPHA_POSITIONS = 3;
const MAX_SELL_GAP = 20;
const SIGNAL_LIFETIME = 20;
const MIN_RESERVE = 10 * SOL;

type SellerRun = {
  firstSlot: number;
  lastSlot: number;
  sold: number;
  otherFlowAtLastSell: number;
};

type Trader = { net: number; run?: SellerRun };
type Tape = {
  net: number;
  traders: Map<string, Trader>;
  activeSellers: Set<Trader>;
};

type Entry = { coverage: boolean; exitSlot: number; cost: number; qualifies: boolean };

export function createStrategy(overrides: Partial<Params> = {}): Bot {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const budget = BigInt(Math.floor(params.riskSol * SOL));
  const minSold = params.minSellerSol * SOL;
  const tapes = new Map<string, Tape>();
  const watching = new Set<string>();
  const entries = new Map<string, Entry>();
  const completed = new Set<string>();

  return {
    onHello() {},
    onBatch(state, batch) {
      const slot = batch.slot;
      const txFee = state.txFeeLamports();
      const pending = new Map([...state.pending.values()].map(({ order }) => [order.mint, order]));

      for (const fill of batch.fills) {
        if (fill.status !== 'filled') continue;
        if (fill.side === 'buy') {
          const coverage = fill.client_id.startsWith('cover-');
          const spent = BigInt(fill.quote_lamports);
          entries.set(fill.mint, {
            coverage,
            exitSlot: fill.slot + (coverage ? 0 : params.holdSlots),
            cost: Number(spent + BigInt(fill.tx_fee_lamports)),
            qualifies: spent >= MIN_ROUND_TRIP,
          });
        } else if (!state.positions.has(fill.mint)) {
          if (entries.get(fill.mint)?.qualifies) completed.add(fill.mint);
          entries.delete(fill.mint);
        }
      }

      for (const event of batch.events) {
        if (event.event === 'CompleteEvent') {
          tapes.delete(event.mint);
          watching.delete(event.mint);
        }
        if (event.event !== 'TradeEvent') continue;
        let tape = tapes.get(event.mint);
        if (!tape) {
          tape = { net: 0, traders: new Map(), activeSellers: new Set() };
          tapes.set(event.mint, tape);
        }
        let trader = tape.traders.get(event.user);
        if (!trader) {
          trader = { net: 0 };
          tape.traders.set(event.user, trader);
        }
        const quote = Number(event.quote_amount);
        const signedQuote = event.is_buy ? quote : -quote;
        tape.net += signedQuote;
        trader.net += signedQuote;
        if (event.is_buy) continue;

        let run = trader.run;
        if (!run || slot - run.lastSlot > MAX_SELL_GAP) {
          run = { firstSlot: slot, lastSlot: slot, sold: 0, otherFlowAtLastSell: 0 };
          trader.run = run;
          tape.activeSellers.delete(trader);
        }
        run.lastSlot = slot;
        run.sold += quote;
        // Snapshot the other wallets' flow after each sell so the quiet period starts fresh.
        run.otherFlowAtLastSell = tape.net - trader.net;
        if (run.firstSlot < slot && run.sold >= minSold) {
          tape.activeSellers.add(trader);
          watching.add(event.mint);
        }
      }

      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const sellFeeRate = (state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback) / 10_000;
      let coverageInFlight = 0;
      let alphaInFlight = 0;
      for (const [mint, entry] of entries) {
        if (entry.coverage) coverageInFlight++;
        else alphaInFlight++;
        const position = state.positions.get(mint);
        if (!position || pending.has(mint) || orders.length >= caps.max_orders_per_batch) continue;
        const mark = batch.marks.find((item) => item.mint === mint);
        if (!mark) continue;
        const tokens = Number(position.token_amount);
        const gross = Math.min(Number(mark.real_quote_reserves),
          tokens * Number(mark.virtual_quote_reserves) / (Number(mark.virtual_token_reserves) + tokens));
        const netReturn = (gross * (1 - sellFeeRate) - Number(txFee)) / entry.cost - 1;
        if (slot >= entry.exitSlot || netReturn >= params.takeProfit || netReturn <= -params.stopLoss) {
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        }
      }
      for (const order of pending.values()) {
        if (order.side !== 'buy') continue;
        if (order.client_id.startsWith('cover-')) coverageInFlight++;
        else alphaInFlight++;
      }

      let room = caps.max_open_positions - state.committedPositionCount();
      let cash = state.freeCashLamports() - BigInt(orders.length) * txFee;
      const sendBuy = (mint: string, spend: bigint, kind: 'cover' | 'exhaustion') => {
        if (cash < spend + txFee || room <= 0 || orders.length >= caps.max_orders_per_batch) return false;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: spend,
          max_slippage_bps: kind === 'cover' ? 100 : params.buySlippageBps,
          client_id: `${kind}-${batch.seq}-${orders.length}`,
        });
        cash -= spend + txFee;
        room--;
        return true;
      };

      const candidates: { mint: string; otherFlow: number; trader: Trader }[] = [];
      // A batch for another mint can still advance the quiet clock.
      for (const mint of watching) {
        const tape = tapes.get(mint)!;
        const curve = state.curves.get(mint)!;
        const canEnter = !curve.complete && Number(curve.real_quote_reserves) >= MIN_RESERVE &&
          !pending.has(mint) && !state.positions.has(mint);
        let best: (typeof candidates)[number] | undefined;
        for (const trader of tape.activeSellers) {
          const run = trader.run!;
          const elapsed = slot - run.lastSlot;
          if (elapsed > params.quietSlots + SIGNAL_LIFETIME) {
            tape.activeSellers.delete(trader);
            trader.run = undefined;
            continue;
          }
          if (!canEnter || elapsed < params.quietSlots) continue;
          const otherFlow = tape.net - trader.net - run.otherFlowAtLastSell;
          if (otherFlow > (best?.otherFlow ?? 0)) best = { mint, otherFlow, trader };
        }
        if (tape.activeSellers.size === 0) watching.delete(mint);
        if (best) candidates.push(best);
      }

      candidates.sort((a, b) => b.otherFlow - a.otherFlow);
      const buying = new Set<string>();
      for (const { mint, trader } of candidates) {
        if (alphaInFlight >= MAX_ALPHA_POSITIONS) break;
        const cap = state.maxBuyLamports(mint);
        const spend = cap < budget ? cap : budget;
        if (spend < COVER_BUDGET) continue;
        if (!sendBuy(mint, spend, 'exhaustion')) break;
        tapes.get(mint)!.activeSellers.delete(trader);
        trader.run = undefined;
        buying.add(mint);
        alphaInFlight++;
      }

      // Take tiny, immediate round trips on quiet curves to meet the coverage target.
      if (completed.size + coverageInFlight < COVER_TARGET && room > 0) {
        for (const [mint, curve] of state.curves) {
          if (completed.size + coverageInFlight >= COVER_TARGET || room <= 0) break;
          if (curve.complete || curve.trades < 3 || slot - curve.reserves_slot < 8 ||
              slot - (curve.created_slot ?? slot) < MIN_COVER_AGE || completed.has(mint) || buying.has(mint) ||
              state.positions.has(mint) || pending.has(mint) || state.maxBuyLamports(mint) < COVER_BUDGET) continue;
          if (!sendBuy(mint, COVER_BUDGET, 'cover')) break;
          coverageInFlight++;
        }
      }
      return orders;
    },
    onDone() {},
  };
}
