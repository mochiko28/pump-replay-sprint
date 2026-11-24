import type { Bot, OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  minReserveSol: 25,
  minPriorNetSol: 5,
  minSingleDrop: 0.04,
  holdSlots: 112,
  exitMove: 0.12,
  riskSol: 0.45,
  buySlippageBps: 200,
  scaleInDrop: 0.02,
  quietMaxActiveMints: 10,
  quietHoldSlots: 36,
  quietRiskSol: 0.45,
  quietSlippageBps: 200,
  quietExitMove: 0.08,
  momentumMinAge: 12,
  momentumMaxAge: 600,
  momentumMinNet: 0.5,
  momentumGapSlots: 10,
  momentumMinReserve: 8,
};

type Params = typeof DEFAULT_PARAMS;
const SOL = 1_000_000_000;
const MIN_ROUND_TRIP = 10_000_000n;
// Leave room for the curve's integer fee rounding.
const COVER_BUDGET = MIN_ROUND_TRIP + 1_000n;
// Leave headroom above 20 completed mints for pending buys and unsold positions.
const COVER_TARGET = 30;
const MAX_COVER_POSITIONS = 2;
const RESERVED_ALPHA_POSITIONS = 2;
const COVER_SELL_FAILURE_LIMIT = 3;
const COVER_SELL_RETRY_SLOTS = 64;
const FLOW_SLOTS = 64;
const MIN_SIGNAL_AGE = 64;
const MIN_DIP_FROM_HIGH = 0.06;
const MIN_SLOT_DROP = 0.025;
const ENTRY_COOLDOWN = 32;
const MAX_ALPHA_POSITIONS = 3;
const QUIET_LOOKBACK_SLOTS = 2_500;
const BASELINE_QUIET_MAX_MINTS = 6;
const QUIET_MIN_RESERVE_SOL = 9;
// Keep cash above 60% of the observed equity high, allowing a buffer before the 50% DD limit.
const CASH_FLOOR_BPS = 6_000n;
const BPS = 10_000n;

type Flow = { slot: number; net: number; high: number; singleDrop: number; outsideBuy: boolean };
type Tape = {
  price: number;
  flow: Flow[];
  firstPrice: number;
  creator: string;
  lastTradeSlot?: number;
  gapSlots: number;
};
type Entry = {
  coverage: boolean;
  exitSlot: number;
  cost: number;
  qualifies: boolean;
  entryPrice: number;
  entryFillSlot: number;
  scaledIn: boolean;
  creatorExit: boolean;
  quiet: boolean;
  sellFailures: number;
  retrySellSlot: number;
};

export function createStrategy(overrides: Partial<Params> = {}): Bot {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const budget = BigInt(Math.floor(params.riskSol * SOL));
  const quietBudget = BigInt(Math.floor(params.quietRiskSol * SOL));
  const tapes = new Map<string, Tape>();
  const entries = new Map<string, Entry>();
  const completed = new Set<string>();
  const lastSignal = new Map<string, number>();
  const quietEntries = new Set<string>();
  const recentTradeSlots = new Map<string, number>();
  let firstObservedSlot: number | undefined;
  let peakEquity = 0n;

  return {
    onBatch(state, batch) {
      const slot = batch.slot;
      firstObservedSlot ??= slot;
      const txFee = state.txFeeLamports();
      const marks = new Map(batch.marks.map((mark) => [mark.mint, mark]));
      const pending = new Map([...state.pending.values()].map(({ order }) => [order.mint, order]));
      for (const fill of batch.fills) {
        if (fill.status !== 'filled') {
          const entry = entries.get(fill.mint);
          if (fill.side === 'sell' && entry?.coverage) {
            entry.sellFailures++;
            if (entry.sellFailures >= COVER_SELL_FAILURE_LIMIT) {
              entry.sellFailures = 0;
              entry.retrySellSlot = fill.slot + COVER_SELL_RETRY_SLOTS;
            }
          }
          continue;
        }
        if (fill.side === 'buy') {
          const coverage = fill.client_id.startsWith('cover-');
          const quiet = fill.client_id.startsWith('quiet-');
          const spent = BigInt(fill.quote_lamports);
          const cost = Number(spent + BigInt(fill.tx_fee_lamports));
          const entry = entries.get(fill.mint);
          if (entry && fill.client_id.startsWith('add-')) {
            entry.cost += cost;
            entry.qualifies ||= spent >= MIN_ROUND_TRIP;
            entry.scaledIn = true;
            continue;
          }
          const mark = marks.get(fill.mint);
          const coverTape = coverage ? tapes.get(fill.mint) : undefined;
          const coverHoldSlots = coverTape && mark &&
            Number(mark.virtual_quote_reserves) / Number(mark.virtual_token_reserves) > coverTape.price * 1.005
            ? 16 : 0;
          entries.set(fill.mint, {
            coverage,
            exitSlot: fill.slot + (coverage ? coverHoldSlots : quiet ? params.quietHoldSlots : params.holdSlots),
            cost,
            qualifies: spent >= MIN_ROUND_TRIP,
            entryPrice: mark ? Number(mark.virtual_quote_reserves) / Number(mark.virtual_token_reserves) : 0,
            entryFillSlot: fill.slot,
            scaledIn: false,
            creatorExit: false,
            quiet,
            sellFailures: 0,
            retrySellSlot: 0,
          });
        } else if (!state.positions.has(fill.mint)) {
          if (entries.get(fill.mint)?.qualifies) completed.add(fill.mint);
          entries.delete(fill.mint);
        }
      }

      const touched = new Map<string, Tape>();
      for (const event of batch.events) {
        if (event.event === 'CompleteEvent') {
          tapes.delete(event.mint);
          touched.delete(event.mint);
          continue;
        }
        const price = Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        if (event.event === 'CreateEvent') {
          tapes.set(event.mint, { price, firstPrice: price, flow: [], creator: event.creator, gapSlots: 0 });
          continue;
        }
        if (event.event === 'TradeEvent' && typeof event.mint === 'string') {
          // Count market activity for every traded mint, even one whose create was not seen.
          if (recentTradeSlots.get(event.mint) !== slot) {
            recentTradeSlots.delete(event.mint);
            recentTradeSlots.set(event.mint, slot);
          }
        }
        const tape = tapes.get(event.mint);
        if (!tape) continue;
        if (
          !event.is_buy &&
          typeof tape.creator === 'string' && tape.creator.length > 0 &&
          event.user === tape.creator &&
          /^[1-9][0-9]*$/.test(String(event.token_amount ?? ''))
        ) {
          const entry = entries.get(event.mint);
          // The replay processes chain trades before bot fills in the same slot.
          if (entry && entry.entryFillSlot < event.slot && state.positions.has(event.mint)) {
            entry.creatorExit = true;
          }
        }
        if (!touched.has(event.mint)) {
          tape.firstPrice = tape.price;
          tape.gapSlots = slot - (tape.lastTradeSlot ?? slot);
          tape.lastTradeSlot = slot;
          let expired = 0;
          while (expired < tape.flow.length && tape.flow[expired].slot < slot - FLOW_SLOTS) expired++;
          if (expired > 0) tape.flow.splice(0, expired);
          tape.flow.push({ slot, net: 0, high: price, singleDrop: 0, outsideBuy: false });
          touched.set(event.mint, tape);
        }
        const current = tape.flow[tape.flow.length - 1];
        current.net += (event.is_buy ? 1 : -1) * Number(event.quote_amount) / SOL;
        current.high = Math.max(current.high, price);
        if (event.is_buy && event.user !== tape.creator) current.outsideBuy = true;
        if (!event.is_buy) current.singleDrop = Math.max(current.singleDrop, 1 - price / tape.price);
        tape.price = price;
      }

      const orders: OrderInput[] = [];
      const scaleIns: string[] = [];
      const caps = state.hello.caps;
      const coverLimit = Math.min(MAX_COVER_POSITIONS, caps.max_open_positions - RESERVED_ALPHA_POSITIONS);
      const sellFeeRate = (state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback) / 10_000;
      let equity = state.cash;
      let coverageInFlight = 0;
      let alphaInFlight = 0;
      for (const [mint, entry] of entries) {
        if (entry.coverage) coverageInFlight++;
        else alphaInFlight++;
        const position = state.positions.get(mint);
        if (!position) continue;
        const mark = marks.get(mint);
        const tokens = Number(position.token_amount);
        const gross = mark ? Math.min(Number(mark.real_quote_reserves),
          tokens * Number(mark.virtual_quote_reserves) / (Number(mark.virtual_token_reserves) + tokens)) : 0;
        equity += BigInt(Math.ceil(gross));
        if (pending.has(mint) || slot < entry.retrySellSlot || orders.length >= caps.max_orders_per_batch) continue;
        const netReturn = (gross * (1 - sellFeeRate) - Number(txFee)) / entry.cost - 1;
        const exitMove = entry.quiet ? params.quietExitMove : params.exitMove;
        // Cover positions are due after their fill-time hold and any retry pause.
        if (entry.creatorExit || slot >= entry.exitSlot || (mark && Math.abs(netReturn) >= exitMove)) {
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        const tape = touched.get(mint);
        if (mark && !entry.coverage && !entry.quiet && !entry.scaledIn && slot > entry.entryFillSlot && tape &&
            tape.flow.at(-1)!.singleDrop >= params.minSingleDrop &&
            Number(mark.virtual_quote_reserves) / Number(mark.virtual_token_reserves) <=
              entry.entryPrice * (1 - params.scaleInDrop)) {
          scaleIns.push(mint);
        }
      }
      for (const order of pending.values()) {
        if (order.side !== 'buy') continue;
        if (order.client_id.startsWith('cover-')) coverageInFlight++;
        else if (!order.client_id.startsWith('add-')) alphaInFlight++;
      }

      if (equity > peakEquity) peakEquity = equity;
      const cashFloor = peakEquity * CASH_FLOOR_BPS / BPS;
      let room = caps.max_open_positions - state.committedPositionCount();
      let cash = state.freeCashLamports() - BigInt(orders.length) * txFee;
      const buying = new Set<string>();
      const sendBuy = (mint: string, spend: bigint, kind: 'cover' | 'dip' | 'add' | 'quiet') => {
        if (cash - spend - txFee < cashFloor || (kind !== 'add' && room <= 0) ||
            orders.length >= caps.max_orders_per_batch) return false;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: spend,
          max_slippage_bps: kind === 'cover' ? 100 : kind === 'quiet' ? params.quietSlippageBps : params.buySlippageBps,
          client_id: `${kind}-${batch.seq}-${orders.length}`,
        });
        buying.add(mint);
        cash -= spend + txFee;
        if (kind !== 'add') room--;
        return true;
      };

      for (const [mint, lastTradeSlot] of recentTradeSlots) {
        if (lastTradeSlot > slot - QUIET_LOOKBACK_SLOTS) break;
        recentTradeSlots.delete(mint);
      }
      const warmedUp = slot - firstObservedSlot >= QUIET_LOOKBACK_SLOTS;
      const quiet = warmedUp && recentTradeSlots.size <= params.quietMaxActiveMints;
      const minReserveSol = warmedUp && recentTradeSlots.size <= BASELINE_QUIET_MAX_MINTS
        ? Math.min(params.minReserveSol, QUIET_MIN_RESERVE_SOL) : params.minReserveSol;

      const signals: { mint: string; depth: number; quiet: boolean }[] = [];
      if (alphaInFlight < MAX_ALPHA_POSITIONS && room > 0) {
        for (const [mint, tape] of touched) {
          if (pending.has(mint) || state.positions.has(mint) ||
              slot - (lastSignal.get(mint) ?? -Infinity) < ENTRY_COOLDOWN) continue;
          const curve = state.curves.get(mint)!;
          const age = slot - (curve.created_slot ?? slot);
          if (curve.complete) continue;
          const reserve = Number(curve.real_quote_reserves) / SOL;
          const current = tape.flow.at(-1)!;
          let priorNet = 0;
          let priorHigh = 0;
          // Keep the signal slot out of the buying history.
          for (let i = 0; i < tape.flow.length - 1; i++) {
            const flow = tape.flow[i];
            priorNet += flow.net;
            priorHigh = Math.max(priorHigh, flow.high);
          }
          const depth = priorHigh > 0 ? 1 - tape.price / priorHigh : 0;
          if (curve.trades >= 5 && age >= MIN_SIGNAL_AGE && reserve >= minReserveSol && priorNet >= params.minPriorNetSol &&
              current.singleDrop >= params.minSingleDrop &&
              tape.price <= tape.firstPrice * (1 - MIN_SLOT_DROP) && depth >= MIN_DIP_FROM_HIGH) {
            signals.push({ mint, depth, quiet: false });
            continue;
          }
          // In a thin tape, renewed demand after a pause can precede a second wave.
          // Require outside participation so a creator topping up alone cannot trigger it.
          if (quiet && !quietEntries.has(mint) &&
              reserve >= params.momentumMinReserve && reserve <= params.minReserveSol &&
              age >= params.momentumMinAge && age <= params.momentumMaxAge &&
              tape.gapSlots >= params.momentumGapSlots && current.outsideBuy &&
              current.net >= params.momentumMinNet) {
            signals.push({ mint, depth: 0, quiet: true });
          }
        }
      }
      signals.sort((a, b) => b.depth - a.depth);
      // Leave room for small reserve changes caused by earlier round trips and rounding.
      const buyCap = (mint: string) => {
        const cap = state.maxBuyLamports(mint);
        return quiet ? cap * 99n / 100n : cap;
      };
      for (const { mint, quiet: quietEntry } of signals) {
        if (alphaInFlight >= MAX_ALPHA_POSITIONS) break;
        const cap = buyCap(mint);
        const spend = quietEntry ? quietBudget : budget;
        if (cap < COVER_BUDGET || spend < COVER_BUDGET) continue;
        if (!sendBuy(mint, cap < spend ? cap : spend, quietEntry ? 'quiet' : 'dip')) break;
        if (quietEntry) quietEntries.add(mint);
        lastSignal.set(mint, slot);
        alphaInFlight++;
      }

      for (const mint of scaleIns) {
        const cap = buyCap(mint);
        const spend = cap < budget ? cap : budget;
        if (spend >= COVER_BUDGET) sendBuy(mint, spend, 'add');
      }

      // Reserve can clear the buy cap for just one batch on a thin curve.
      for (const [mint, curve] of state.curves) {
        if (coverageInFlight >= coverLimit || completed.size + coverageInFlight >= COVER_TARGET || room <= 0) break;
        if (curve.complete || completed.has(mint) || buying.has(mint) ||
            state.positions.has(mint) || pending.has(mint) || state.maxBuyLamports(mint) < COVER_BUDGET) continue;
        if (!sendBuy(mint, COVER_BUDGET, 'cover')) break;
        coverageInFlight++;
      }
      return orders;
    },
  };
}
