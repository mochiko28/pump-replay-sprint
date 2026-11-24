import type { Bot, OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  minReserveSol: 20,
  minPriorNetSol: 5,
  minSingleDrop: 0.04,
  holdSlots: 112,
  exitMove: 0.12,
  riskSol: 0.45,
  buySlippageBps: 200,
  scaleInDrop: 0.02,
};

type Params = typeof DEFAULT_PARAMS;
const SOL = 1_000_000_000;
const MIN_ROUND_TRIP = 10_000_000n;
// Leave room for the curve's integer fee rounding.
const COVER_BUDGET = MIN_ROUND_TRIP + 1_000n;
const COVER_TARGET = 21;
const MIN_COVER_AGE = 32;
const FLOW_SLOTS = 64;
const MIN_SIGNAL_AGE = 64;
const MIN_DIP_FROM_HIGH = 0.06;
const MIN_SLOT_DROP = 0.025;
const ENTRY_COOLDOWN = 32;
const MAX_ALPHA_POSITIONS = 3;

type Flow = { slot: number; net: number; high: number; singleDrop: number };
type Tape = {
  price: number;
  flow: Flow[];
  firstPrice: number;
};
type Entry = {
  coverage: boolean;
  exitSlot: number;
  cost: number;
  qualifies: boolean;
  entryPrice: number;
  entryFillSlot: number;
  scaledIn: boolean;
};

export function createStrategy(overrides: Partial<Params> = {}): Bot {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const budget = BigInt(Math.floor(params.riskSol * SOL));
  const tapes = new Map<string, Tape>();
  const entries = new Map<string, Entry>();
  const completed = new Set<string>();
  const lastSignal = new Map<string, number>();

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
          const cost = Number(spent + BigInt(fill.tx_fee_lamports));
          const entry = entries.get(fill.mint);
          if (entry && fill.client_id.startsWith('add-')) {
            entry.cost += cost;
            entry.qualifies ||= spent >= MIN_ROUND_TRIP;
            entry.scaledIn = true;
            continue;
          }
          const mark = batch.marks.find((item) => item.mint === fill.mint);
          entries.set(fill.mint, {
            coverage,
            exitSlot: fill.slot + (coverage ? 0 : params.holdSlots),
            cost,
            qualifies: spent >= MIN_ROUND_TRIP,
            entryPrice: mark ? Number(mark.virtual_quote_reserves) / Number(mark.virtual_token_reserves) : 0,
            entryFillSlot: fill.slot,
            scaledIn: false,
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
          tapes.set(event.mint, { price, firstPrice: price, flow: [] });
          continue;
        }
        const tape = tapes.get(event.mint);
        if (!tape) continue;
        if (!touched.has(event.mint)) {
          tape.firstPrice = tape.price;
          let expired = 0;
          while (expired < tape.flow.length && tape.flow[expired].slot < slot - FLOW_SLOTS) expired++;
          if (expired > 0) tape.flow.splice(0, expired);
          tape.flow.push({ slot, net: 0, high: price, singleDrop: 0 });
          touched.set(event.mint, tape);
        }
        const current = tape.flow[tape.flow.length - 1];
        current.net += (event.is_buy ? 1 : -1) * Number(event.quote_amount) / SOL;
        current.high = Math.max(current.high, price);
        if (!event.is_buy) current.singleDrop = Math.max(current.singleDrop, 1 - price / tape.price);
        tape.price = price;
      }

      const orders: OrderInput[] = [];
      const scaleIns: string[] = [];
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
        if (slot >= entry.exitSlot || Math.abs(netReturn) >= params.exitMove) {
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        const tape = touched.get(mint);
        if (!entry.coverage && !entry.scaledIn && slot > entry.entryFillSlot && tape &&
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

      let room = caps.max_open_positions - state.committedPositionCount();
      let cash = state.freeCashLamports() - BigInt(orders.length) * txFee;
      const sendBuy = (mint: string, spend: bigint, kind: 'cover' | 'dip' | 'add') => {
        if (cash < spend + txFee || (kind !== 'add' && room <= 0) ||
            orders.length >= caps.max_orders_per_batch) return false;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: spend,
          max_slippage_bps: kind === 'cover' ? 100 : params.buySlippageBps,
          client_id: `${kind}-${batch.seq}-${orders.length}`,
        });
        cash -= spend + txFee;
        if (kind !== 'add') room--;
        return true;
      };

      const dips: { mint: string; depth: number }[] = [];
      if (alphaInFlight < MAX_ALPHA_POSITIONS && room > 0 && budget >= COVER_BUDGET) {
        for (const [mint, tape] of touched) {
          if (tape.price > tape.firstPrice * (1 - MIN_SLOT_DROP) || pending.has(mint) ||
              state.positions.has(mint) || slot - (lastSignal.get(mint) ?? -Infinity) < ENTRY_COOLDOWN) continue;
          const curve = state.curves.get(mint)!;
          if (curve.complete || curve.trades < 5 || slot - (curve.created_slot ?? slot) < MIN_SIGNAL_AGE ||
              tape.flow.at(-1)!.singleDrop < params.minSingleDrop ||
              Number(curve.real_quote_reserves) < params.minReserveSol * SOL) continue;
          let priorNet = 0;
          let priorHigh = 0;
          // Keep the signal slot's selling out of the buying history.
          for (let i = 0; i < tape.flow.length - 1; i++) {
            const flow = tape.flow[i];
            priorNet += flow.net;
            priorHigh = Math.max(priorHigh, flow.high);
          }
          if (priorNet < params.minPriorNetSol || priorHigh <= 0) continue;
          const depth = 1 - tape.price / priorHigh;
          if (depth >= MIN_DIP_FROM_HIGH) dips.push({ mint, depth });
        }
      }
      dips.sort((a, b) => b.depth - a.depth);
      const buying = new Set<string>();
      for (const { mint } of dips) {
        if (alphaInFlight >= MAX_ALPHA_POSITIONS) break;
        const cap = state.maxBuyLamports(mint);
        if (cap < COVER_BUDGET) continue;
        if (!sendBuy(mint, cap < budget ? cap : budget, 'dip')) break;
        lastSignal.set(mint, slot);
        buying.add(mint);
        alphaInFlight++;
      }

      for (const mint of scaleIns) {
        const cap = state.maxBuyLamports(mint);
        const spend = cap < budget ? cap : budget;
        if (spend >= COVER_BUDGET) sendBuy(mint, spend, 'add');
      }

      // A tiny, immediate round trip on a quiet curve uses little exposure and few fees.
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
