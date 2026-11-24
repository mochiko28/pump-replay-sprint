import { BPS, LAMPORTS_PER_SOL as SOL, type Bot, type OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  holdSlots: 120,
  takeProfit: 0.25,
  stopLoss: 0.20,
};

type Params = typeof DEFAULT_PARAMS;
const MIN_RESERVE = 50n * SOL;
const MAX_RESERVE = 60n * SOL;
const EXIT_RESERVE = 80n * SOL;
const FLOW_SLOTS = 32;
const MAX_RUN_POSITIONS = 3;
const COVER_TARGET = 21;
const MIN_ROUND_TRIP = 10_001_000n;
const COVER_BUDGET = MIN_ROUND_TRIP + 2n;

type Flow = { slot: number; net: bigint };
type Tape = { net: bigint; slots: Flow[] };
type Entry = { coverage: boolean; exitSlot: number; cost: bigint; qualifies: boolean; exiting: boolean };

export function createStrategy(overrides: Partial<Params> = {}): Bot {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const tapes = new Map<string, Tape>();
  const entries = new Map<string, Entry>();
  const attempted = new Set<string>();
  const completed = new Set<string>();

  return {
    onHello() {},
    onBatch(state, batch) {
      const { caps, fees } = state.hello;
      const { slot } = batch;
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
            cost: spent + BigInt(fill.tx_fee_lamports),
            qualifies: spent >= MIN_ROUND_TRIP,
            exiting: false,
          });
        } else if (!state.positions.has(fill.mint)) {
          if (entries.get(fill.mint)?.qualifies) completed.add(fill.mint);
          entries.delete(fill.mint);
        }
      }

      const touched = new Set<string>();
      for (const event of batch.events) {
        const { mint } = event;
        if (event.event === 'CompleteEvent') {
          tapes.delete(mint);
          touched.delete(mint);
        }
        if (event.event !== 'TradeEvent' || attempted.has(mint)) continue;

        let tape = tapes.get(mint);
        if (!tape) {
          tape = { net: 0n, slots: [] };
          tapes.set(mint, tape);
        }
        if (!touched.has(mint)) {
          while (tape.slots.length && tape.slots[0].slot <= slot - FLOW_SLOTS) {
            tape.net -= tape.slots.shift()!.net;
          }
          tape.slots.push({ slot, net: 0n });
          touched.add(mint);
        }
        const net = BigInt(event.quote_amount) * (event.is_buy ? 1n : -1n);
        tape.slots[tape.slots.length - 1].net += net;
        tape.net += net;
      }

      const orders: OrderInput[] = [];
      const marks = new Map(batch.marks.map((mark) => [mark.mint, mark]));
      const sellFeeRate = (fees.protocol_bps_fallback + fees.creator_bps_fallback) / Number(BPS);
      let coverageInFlight = 0;
      let runsInFlight = 0;
      for (const [mint, entry] of entries) {
        if (entry.coverage) coverageInFlight++;
        else runsInFlight++;
        const position = state.positions.get(mint);
        if (!position || pending.has(mint) || orders.length >= caps.max_orders_per_batch) continue;
        const mark = marks.get(mint);
        if (!mark) continue;

        const tokens = Number(position.token_amount);
        const reserve = Number(mark.real_quote_reserves);
        const gross = Math.min(reserve,
          tokens * Number(mark.virtual_quote_reserves) / (Number(mark.virtual_token_reserves) + tokens));
        const netReturn = (gross * (1 - sellFeeRate) - Number(txFee)) / Number(entry.cost) - 1;
        if (entry.exiting || slot >= entry.exitSlot || netReturn >= params.takeProfit ||
            netReturn <= -params.stopLoss || reserve >= Number(EXIT_RESERVE)) {
          entry.exiting = true;
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
        }
      }
      for (const order of pending.values()) {
        if (order.side !== 'buy') continue;
        if (order.client_id.startsWith('cover-')) coverageInFlight++;
        else runsInFlight++;
      }

      let room = caps.max_open_positions - state.committedPositionCount();
      let cash = state.freeCashLamports() - BigInt(orders.length) * txFee;
      const buying = new Set<string>();
      const sendBuy = (mint: string, spend: bigint, kind: 'cover' | 'run') => {
        if (cash < spend + txFee || room <= 0 || orders.length >= caps.max_orders_per_batch) return false;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: spend,
          max_slippage_bps: kind === 'cover' ? 100 : 1_000,
          client_id: `${kind}-${batch.seq}-${orders.length}`,
        });
        cash -= spend + txFee;
        room--;
        buying.add(mint);
        return true;
      };

      for (const mint of touched) {
        if (runsInFlight >= MAX_RUN_POSITIONS || room <= 0) break;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete || pending.has(mint) || state.positions.has(mint) ||
            curve.real_quote_reserves < MIN_RESERVE || curve.real_quote_reserves >= MAX_RESERVE ||
            tapes.get(mint)!.net > 0n) continue;
        const onePercent = curve.real_quote_reserves / 100n;
        const cap = state.maxBuyLamports(mint);
        const spend = cap < onePercent ? cap : onePercent;
        if (spend < COVER_BUDGET || !sendBuy(mint, spend, 'run')) continue;
        attempted.add(mint);
        tapes.delete(mint);
        runsInFlight++;
      }

      // Use the same quiet-curve round trips and selection rules as famC.
      if (completed.size + coverageInFlight < COVER_TARGET && room > 0) {
        for (const [mint, curve] of state.curves) {
          if (completed.size + coverageInFlight >= COVER_TARGET || room <= 0) break;
          if (curve.complete || curve.trades < 3 || slot - curve.reserves_slot < 8 ||
              slot - (curve.created_slot ?? slot) < 32 || completed.has(mint) || buying.has(mint) ||
              state.positions.has(mint) || pending.has(mint) || state.maxBuyLamports(mint) < COVER_BUDGET ||
              curve.real_quote_reserves / 100n < COVER_BUDGET) continue;
          if (!sendBuy(mint, COVER_BUDGET, 'cover')) break;
          coverageInFlight++;
        }
      }
      return orders;
    },
    onDone() {},
  };
}
