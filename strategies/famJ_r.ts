import { U64_MAX, type Bot, type ChainEvent, type OrderInput, type TradeEventRecord } from '../vendor/makefun-bot.ts';

const SPIKE_FADE_MAX_AGE = 32;

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
  newEntries: [{
    signal: 'spike-fade', minReserve: 8, maxReserve: 16, maxAge: SPIKE_FADE_MAX_AGE,
    holdSlots: 36, exitMove: 1, riskSol: 0.25,
  }] as EntryRule[],
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
const SIGNAL_LOOKBACK_SLOTS = 64;
const SIGNAL_TAPE_MAX_AGE = SPIKE_FADE_MAX_AGE + SIGNAL_LOOKBACK_SLOTS;
const SIGNAL_TAPE_IDLE_SLOTS = 300;
const MAX_SIGNAL_PRINTS = 128;
const SPIKE_FADE_ENTRY_WINDOW = 2_500;
const MAX_SPIKE_FADE_ENTRIES = 12;
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

type Signal = 'first-large-buy' | 'cross-40' | 'cross-55' | 'cross-70' | 'creator-exit' |
  'sell-cluster' | 'cluster-reclaim' | 'spike-fade' | 'wallet-relay';
type EntryRule = {
  signal: Signal;
  minReserve?: number;
  maxReserve?: number;
  minAge?: number;
  maxAge?: number;
  holdSlots: number;
  exitMove: number;
  riskSol: number;
  quietOnly?: boolean;
};
type Print = { slot: number; before: number; price: number; quote: number; buy: boolean; outsider: boolean; user: string };
type SignalTape = {
  created: number;
  lastTradeSlot: number;
  creator: string;
  creatorTokens: bigint;
  creatorExit?: { slot: number; price: number; outsideBuys: number };
  firstLargeBuy: boolean;
  crossed: Set<number>;
  prints: Print[];
  price: number;
  fired: Map<Signal, number>;
};
type ObservedTrade = { trade: TradeEventRecord; reserveLamports: bigint };
type Opportunity = ObservedTrade & { signal: Signal; age: number; reserve: number };

function readUnsignedField(value: string): bigint | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return;
  const amount = BigInt(value);
  return amount <= U64_MAX ? amount : undefined;
}

function readSignalPrice(event: Pick<TradeEventRecord, 'virtual_quote_reserves' | 'virtual_token_reserves'>): number {
  return Number(readUnsignedField(event.virtual_quote_reserves)) /
    Number(readUnsignedField(event.virtual_token_reserves));
}

export class EntrySignals {
  private readonly tapes = new Map<string, SignalTape>();

  update(events: ChainEvent[], batchSlot = events.at(-1)?.slot): Map<string, Opportunity[]> {
    // Batches arrive in slot order, so each expired tape is visited and removed once.
    if (batchSlot !== undefined) {
      for (const [mint, tape] of this.tapes) {
        if (batchSlot - tape.created <= SIGNAL_TAPE_MAX_AGE &&
            batchSlot - tape.lastTradeSlot <= SIGNAL_TAPE_IDLE_SLOTS) break;
        this.tapes.delete(mint);
      }
    }
    const candidates = new Map<string, Set<Signal>>();
    const last = new Map<string, ObservedTrade>();
    const spikeFades = new Map<string, ObservedTrade>();
    for (const event of events) {
      const { mint, slot } = event;
      if (event.event === 'CreateEvent') {
        const price = readSignalPrice(event);
        if (!Number.isFinite(price) || price <= 0) continue;
        this.tapes.delete(mint);
        this.tapes.set(mint, {
          created: slot, lastTradeSlot: slot, creator: event.creator, creatorTokens: 0n, firstLargeBuy: false,
          crossed: new Set(), prints: [], fired: new Map(), price,
        });
        continue;
      }
      if (event.event === 'CompleteEvent') {
        this.tapes.delete(mint);
        last.delete(mint);
        spikeFades.delete(mint);
        candidates.delete(mint);
        continue;
      }
      const tape = this.tapes.get(mint);
      if (!tape) continue;
      const price = readSignalPrice(event);
      const reserveLamports = readUnsignedField(event.real_quote_reserves);
      const reserve = Number(reserveLamports) / SOL;
      const quote = Number(readUnsignedField(event.quote_amount)) / SOL;
      if (reserveLamports === undefined || !Number.isFinite(reserve) ||
          !Number.isFinite(price) || price <= 0 || !Number.isFinite(quote)) continue;
      const outsider = event.user !== tape.creator;
      let creatorAmount = 0n;
      if (!outsider) {
        try {
          const amount = String(event.token_amount ?? '');
          if (amount.length > 20 || !/^[1-9][0-9]*$/.test(amount)) continue;
          creatorAmount = BigInt(amount);
          if (creatorAmount > U64_MAX) continue;
        } catch {
          continue;
        }
      }
      let signals = candidates.get(mint);
      if (!signals) candidates.set(mint, signals = new Set());
      const buy = event.is_buy;
      const before = tape.price;
      tape.price = price;
      tape.lastTradeSlot = slot;
      const observed = { trade: event, reserveLamports };
      last.set(mint, observed);

      if (buy && outsider && quote >= 1 && !tape.firstLargeBuy) {
        tape.firstLargeBuy = true;
        if (slot - tape.created <= 120) signals.add('first-large-buy');
      }
      for (const [threshold, signal] of [[40, 'cross-40'], [55, 'cross-55'], [70, 'cross-70']] as const) {
        if (buy && reserve >= threshold && !tape.crossed.has(threshold)) {
          tape.crossed.add(threshold);
          signals.add(signal);
        }
      }

      // Reconstruct the creator's curve-trade inventory from the mint's create onward.
      if (!outsider) {
        if (buy) {
          tape.creatorTokens += creatorAmount;
          tape.creatorExit = undefined;
        } else if (tape.creatorTokens > 0n) {
          tape.creatorTokens = tape.creatorTokens > creatorAmount ? tape.creatorTokens - creatorAmount : 0n;
          if (tape.creatorTokens === 0n) tape.creatorExit = { slot, price, outsideBuys: 0 };
        }
      }
      const exit = tape.creatorExit;
      if (exit) {
        if (buy && outsider) exit.outsideBuys++;
        if (price < exit.price * 0.98) {
          exit.price = price;
          exit.slot = slot;
          exit.outsideBuys = 0;
        }
        if (buy && outsider && exit.outsideBuys >= 2 && slot - exit.slot >= 8) {
          signals.add('creator-exit');
          tape.creatorExit = undefined;
        }
      }

      const prints = tape.prints;
      let expired = 0;
      while (expired < prints.length && prints[expired].slot < slot - SIGNAL_LOOKBACK_SLOTS) expired++;
      expired = Math.max(expired, prints.length - MAX_SIGNAL_PRINTS + 1);
      if (expired) prints.splice(0, expired);
      prints.push({ slot, before, price, quote, buy, outsider, user: event.user });
      let high = price;
      let clusterHigh = price;
      let sells = 0;
      let relayVolume = 0;
      const buyers = new Set<string>();
      for (let i = prints.length - 1; i >= 0; i--) {
        const print = prints[i];
        high = Math.max(high, print.before, print.price);
        if (slot - print.slot <= 24) {
          clusterHigh = Math.max(clusterHigh, print.before, print.price);
          if (!print.buy && print.quote >= 0.05) sells++;
        }
        if (slot - print.slot <= 12 && print.buy && print.outsider) {
          buyers.add(print.user);
          relayVolume += print.quote;
        }
      }
      if (sells >= 3 && price <= clusterHigh * 0.96) {
        if (!buy) signals.add('sell-cluster');
        if (buy && outsider && quote >= 0.15) signals.add('cluster-reclaim');
      }
      // Buy on an outside bid after a partial retracement of a recent spike.
      const base = prints[0].before;
      if (buy && outsider && high >= base * 1.10 && price >= base + 0.20 * (high - base) &&
          price <= base + 0.60 * (high - base) && before < price && quote >= 0.15) {
        signals.add('spike-fade');
        // Keep the latest trigger in the batch: it is the freshest decision-time state.
        spikeFades.set(mint, observed);
      }
      // Several independent wallets can reveal renewed demand even without one large buy.
      if (buy && outsider && buyers.size >= 3 && relayVolume >= 0.5 && sells === 0) signals.add('wallet-relay');
    }
    const opportunities = new Map<string, Opportunity[]>();
    for (const [mint, signals] of candidates) {
      const latest = last.get(mint);
      if (!latest || !signals.size) continue;
      const tape = this.tapes.get(mint)!;
      const opportunitiesForMint: Opportunity[] = [];
      for (const signal of signals) {
        const observed = signal === 'spike-fade' ? spikeFades.get(mint)! : latest;
        const { trade, reserveLamports } = observed;
        const reserve = Number(reserveLamports) / SOL;
        if (reserve < 1) continue;
        if (trade.slot - (tape.fired.get(signal) ?? -Infinity) < 32) continue;
        tape.fired.set(signal, trade.slot);
        opportunitiesForMint.push({ ...observed, signal, age: trade.slot - tape.created, reserve });
      }
      if (opportunitiesForMint.length) opportunities.set(mint, opportunitiesForMint);
    }
    return opportunities;
  }
}

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
  rule?: EntryRule;
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
  const detector = params.newEntries.length ? new EntrySignals() : undefined;
  const newRules = params.newEntries.map((rule) => ({ rule, budget: BigInt(Math.floor(rule.riskSol * SOL)) }));
  const submittedRules = new Map<string, EntryRule>();
  const spikeFadeEntrySlots: number[] = [];
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
        const rule = submittedRules.get(fill.client_id);
        submittedRules.delete(fill.client_id);
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
          entries.set(fill.mint, {
            coverage,
            rule,
            exitSlot: fill.slot + (rule?.holdSlots ?? (coverage ? 0 : quiet ? params.quietHoldSlots : params.holdSlots)),
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

      const opportunities = detector?.update(batch.events, slot);
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
        const exitMove = entry.rule?.exitMove ?? (entry.quiet ? params.quietExitMove : params.exitMove);
        // Cover positions are due on the fill slot and after any retry pause.
        if (entry.creatorExit || slot >= entry.exitSlot || (mark && Math.abs(netReturn) >= exitMove)) {
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        const tape = touched.get(mint);
        if (mark && !entry.rule && !entry.coverage && !entry.quiet && !entry.scaledIn && slot > entry.entryFillSlot && tape &&
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
      const sendBuy = (mint: string, spend: bigint, kind: 'cover' | 'dip' | 'add' | 'quiet' | 'signal', rule?: EntryRule) => {
        if (cash - spend - txFee < cashFloor || (kind !== 'add' && room <= 0) ||
            orders.length >= caps.max_orders_per_batch) return false;
        const clientId = `${kind}-${batch.seq}-${orders.length}`;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: spend,
          max_slippage_bps: kind === 'cover' ? 100 : kind === 'quiet' ? params.quietSlippageBps : params.buySlippageBps,
          client_id: clientId,
        });
        if (rule) submittedRules.set(clientId, rule);
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

      while (spikeFadeEntrySlots.length && spikeFadeEntrySlots[0] <= slot - SPIKE_FADE_ENTRY_WINDOW) {
        spikeFadeEntrySlots.shift();
      }
      for (const [mint, observed] of opportunities ?? []) {
        if (alphaInFlight >= MAX_ALPHA_POSITIONS || room <= 0) break;
        if (buying.has(mint) || pending.has(mint) || state.positions.has(mint) ||
            slot - (lastSignal.get(mint) ?? -Infinity) < ENTRY_COOLDOWN) continue;
        const match = newRules.find(({ rule }) => (!rule.quietOnly || quiet) &&
          (rule.signal !== 'spike-fade' || spikeFadeEntrySlots.length < MAX_SPIKE_FADE_ENTRIES) &&
          observed.some(({ signal, age, reserve }) =>
            signal === rule.signal && reserve >= (rule.minReserve ?? 1) && reserve < (rule.maxReserve ?? Infinity) &&
            age >= (rule.minAge ?? 0) && age < (rule.maxAge ?? Infinity)));
        if (!match) continue;
        let cap = buyCap(mint);
        if (match.rule.signal === 'spike-fade') {
          // Size from the trigger and still respect the current executable cap.
          const trigger = observed.find(({ signal }) => signal === 'spike-fade')!;
          let triggerCap = trigger.reserveLamports * BigInt(caps.max_order_bps_of_real_reserve) / BPS;
          if (quiet) triggerCap = triggerCap * 99n / 100n;
          if (triggerCap < cap) cap = triggerCap;
        }
        const spend = cap < match.budget ? cap : match.budget;
        if (spend < COVER_BUDGET) continue;
        if (!sendBuy(mint, spend, 'signal', match.rule)) break;
        if (match.rule.signal === 'spike-fade') spikeFadeEntrySlots.push(slot);
        lastSignal.set(mint, slot);
        alphaInFlight++;
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
