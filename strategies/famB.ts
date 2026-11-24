import { LAMPORTS_PER_SOL, type Bot, type OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  entryReserve: 52,
  trailReserve: 9,
  tightenAtReturn: 0.30,
  tightTrailReserve: 1,
};

const MIN_RESERVE_RISE = 0.5;
const GUARD_BUY = 10_100_000n;
const QUALIFYING_BUY = 10_000_000n;
const GUARD_TARGET = 20;
const QUIET_SLOTS = 120;
const GUARD_MIN_RESERVE = 3;

type Params = typeof DEFAULT_PARAMS;
type Observation = { reserve: number; prior: number; high: number; slot: number };
type Trade = { guard: boolean; peak: number; exit: boolean; tightened: boolean };

export function createStrategy(overrides?: Partial<Params>): Bot {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const observed = new Map<string, Observation>();
  const quietQueue: { mint: string; slot: number }[] = [];
  let quietHead = 0;
  const active = new Map<string, Trade>();
  const traded = new Set<string>();
  const qualified = new Set<string>();

  return {
    onHello() {
      observed.clear();
      quietQueue.length = 0;
      quietHead = 0;
      active.clear();
      traded.clear();
      qualified.clear();
    },

    onBatch(state, batch) {
      for (const fill of batch.fills) {
        const trade = active.get(fill.mint);
        if (!trade) continue;
        if (fill.side === 'buy') {
          if (fill.status !== 'filled') {
            active.delete(fill.mint);
            continue;
          }
          if (!trade.guard) traded.add(fill.mint);
          if (BigInt(fill.quote_lamports) >= QUALIFYING_BUY) qualified.add(fill.mint);
        } else if (fill.status === 'filled' && !state.positions.has(fill.mint)) {
          active.delete(fill.mint);
        }
      }

      const changed = new Set<string>();
      for (const event of batch.events) {
        if (event.event === 'CompleteEvent') {
          observed.delete(event.mint);
        } else if (event.event === 'TradeEvent') {
          changed.add(event.mint);
        }
      }
      for (const mint of changed) {
        const curve = state.curves.get(mint)!;
        if (curve.complete) continue;
        const old = observed.get(mint);
        const reserve = Number(curve.real_quote_reserves) / Number(LAMPORTS_PER_SOL);
        observed.set(mint, {
          reserve,
          prior: old?.reserve ?? 0,
          high: Math.max(old?.high ?? 0, reserve),
          slot: batch.slot,
        });
        if (qualified.size < GUARD_TARGET && reserve >= GUARD_MIN_RESERVE) {
          quietQueue.push({ mint, slot: batch.slot });
        }
      }

      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();
      const { protocol_bps_fallback, creator_bps_fallback } = state.hello.fees;
      const sellProceedsFraction = 1 - (protocol_bps_fallback + creator_bps_fallback) / 10_000;
      const pending = new Set([...state.pending.values()].map(({ order }) => order.mint));
      const marks = new Map(batch.marks.map(mark => [mark.mint, mark]));
      for (const [mint, holding] of state.positions) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const trade = active.get(mint);
        const mark = marks.get(mint);
        const observation = observed.get(mint);
        if (!trade || !mark || !observation || pending.has(mint)) continue;
        const { reserve } = observation;
        trade.peak = Math.max(trade.peak, reserve);
        const gross = holding.token_amount * BigInt(mark.virtual_quote_reserves) /
          (BigInt(mark.virtual_token_reserves) + holding.token_amount);
        const profit = (Number(gross) * sellProceedsFraction - 2 * Number(txFee)) /
          Number(holding.cost_lamports) - 1;
        if (profit >= params.tightenAtReturn) trade.tightened = true;
        const trail = trade.tightened ? params.tightTrailReserve : params.trailReserve;
        if (trade.guard || trade.peak - reserve >= trail) trade.exit = true;
        if (!trade.exit || gross === 0n) continue;

        // Deep reversals can leave less real SOL than the position's quoted proceeds.
        const realReserve = BigInt(mark.real_quote_reserves);
        const sellable = gross <= realReserve
          ? holding.token_amount
          : holding.token_amount * realReserve / gross * 99n / 100n;
        if (sellable * gross / holding.token_amount > txFee * 2n) {
          orders.push({ side: 'sell', mint, token_amount: sellable, max_slippage_bps: 10_000 });
        }
      }

      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      let cash = state.freeCashLamports();
      for (const mint of changed) {
        if (room <= 0 || orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (active.has(mint) || traded.has(mint)) continue;
        const curve = state.curves.get(mint)!;
        const signal = observed.get(mint);
        if (!signal || curve.real_token_reserves === 0n || signal.reserve < params.entryReserve ||
            signal.reserve - signal.prior < MIN_RESERVE_RISE || signal.reserve < signal.high) continue;
        const budget = state.maxBuyLamports(mint);
        if (budget < GUARD_BUY || cash < budget + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: budget, max_slippage_bps: 500 });
        active.set(mint, { guard: false, peak: signal.reserve, exit: false, tightened: false });
        cash -= budget + txFee;
        room--;
      }

      // Qualifying buys will count when sold or flattened. Start only the remaining small trades.
      let guardPending = 0;
      for (const [mint, trade] of active) {
        if (trade.guard && !qualified.has(mint)) guardPending++;
      }
      while (quietHead < quietQueue.length && batch.slot - quietQueue[quietHead].slot >= QUIET_SLOTS) {
        if (qualified.size + guardPending >= GUARD_TARGET || room <= 0 ||
            orders.length >= state.hello.caps.max_orders_per_batch || cash < GUARD_BUY + txFee) break;
        const { mint, slot } = quietQueue[quietHead++];
        if (qualified.has(mint) || active.has(mint) || observed.get(mint)?.slot !== slot ||
            state.maxBuyLamports(mint) < GUARD_BUY) continue;
        orders.push({ side: 'buy', mint, quote_lamports: GUARD_BUY, max_slippage_bps: 150 });
        active.set(mint, { guard: true, peak: 0, exit: false, tightened: false });
        cash -= GUARD_BUY + txFee;
        room--;
        guardPending++;
      }
      return orders;
    },

    onDone() {},
  };
}
