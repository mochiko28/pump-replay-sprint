import type { Bot, ChainEvent, OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  minScore: 0.0038042077095154564,
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
const SCALE_IN_SINGLE_DROP = 0.04;
const ENTRY_COOLDOWN = 32;
const MAX_ALPHA_POSITIONS = 3;

type Entry = {
  coverage: boolean;
  exitSlot: number;
  cost: number;
  qualifies: boolean;
  entryPrice: number;
  entryFillSlot: number;
  scaledIn: boolean;
  creatorExit: boolean;
};

export function createStrategy(overrides: Partial<Params> = {}): Bot {
  return createScoredStrategy(MODEL, overrides);
}

export function createScoredStrategy(model: ScoreModel, overrides: Partial<Params> = {}): Bot {
  const params = { ...DEFAULT_PARAMS, ...overrides };
  const budget = BigInt(Math.floor(params.riskSol * SOL));
  const study = new EntryFeatures();
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
            creatorExit: false,
          });
        } else if (!state.positions.has(fill.mint)) {
          if (entries.get(fill.mint)?.qualifies) completed.add(fill.mint);
          entries.delete(fill.mint);
        }
      }

      const touched = study.update(slot, batch.events, (event) => {
        const entry = entries.get(event.mint);
        // Chain trades precede bot fills in the same slot.
        if (entry && entry.entryFillSlot < event.slot && state.positions.has(event.mint)) {
          entry.creatorExit = true;
        }
      });

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
        // Keep the exit armed across pending orders and failed sell transactions.
        if (entry.creatorExit) {
          orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
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
            tape.slots.at(-1)!.singleDrop >= SCALE_IN_SINGLE_DROP &&
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

      const dips: { mint: string; score: number }[] = [];
      if (alphaInFlight < MAX_ALPHA_POSITIONS && room > 0 && budget >= COVER_BUDGET) {
        for (const [mint, tape] of touched) {
          if (pending.has(mint) || state.positions.has(mint) ||
              slot - (lastSignal.get(mint) ?? -Infinity) < ENTRY_COOLDOWN ||
              state.maxBuyLamports(mint) < COVER_BUDGET) continue;
          const features = study.features(slot, tape);
          if (!features) continue;
          const score = predict(model, features);
          if (score > params.minScore) dips.push({ mint, score });
        }
      }
      dips.sort((a, b) => b.score - a.score);
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

const LOOKBACK = 128;
const EARLY_BUY_SLOTS = 32;
type Buy = { wallet: string; sol: number };
type SlotTape = { slot: number; open: number; net: number; high: number; singleDrop: number; seller: string; buys: Buy[] };
type Tape = {
  created: number;
  creator: string;
  earlyBuyers: Set<string>;
  slots: SlotTape[];
  price: number;
  reserve: number;
};
type Trade = Extract<ChainEvent, { event: 'TradeEvent' }>;

export const FEATURE_NAMES = [
  'single_sell_drop', 'slot_drop', 'drawdown_64', 'drawdown_128',
  'prior_net_sol_32', 'prior_net_sol_64', 'prior_net_sol_128',
  'buyers_64', 'buyers_128', 'top_wallet_buy_share_128', 'median_buy_sol_128',
  'curve_age_slots', 'real_reserve_sol', 'creator_seller', 'early_buyer_seller', 'seconds_since_create',
];

export class EntryFeatures {
  private readonly tapes = new Map<string, Tape>();
  private time = 0;
  private lastCreate: number | undefined;

  update(slot: number, events: ChainEvent[], onCreatorSell?: (event: Trade) => void): Map<string, Tape> {
    const touched = new Map<string, Tape>();
    for (const event of events) {
      const time = event.block_time ?? Number(event.timestamp);
      this.time = Math.max(this.time, time);
      if (event.event === 'CreateEvent') {
        this.lastCreate = this.time;
        this.tapes.set(event.mint, {
          created: slot, creator: event.creator, earlyBuyers: new Set(), slots: [],
          price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves), reserve: 0,
        });
        continue;
      }
      const tape = this.tapes.get(event.mint);
      if (!tape) continue;
      // Leave a completed mint's signal in the study. Execution rejects buys on completed curves.
      if (event.event === 'CompleteEvent') {
        this.tapes.delete(event.mint);
        continue;
      }
      const price = Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
      if (!touched.has(event.mint)) {
        const first = tape.slots.findIndex((record) => record.slot >= slot - LOOKBACK);
        if (first < 0) tape.slots.length = 0;
        else if (first > 0) tape.slots.splice(0, first);
        tape.slots.push({ slot, open: tape.price, net: 0, high: tape.price, singleDrop: 0, seller: '', buys: [] });
        touched.set(event.mint, tape);
      }
      const current = tape.slots.at(-1)!;
      const volume = Number(event.quote_amount) / SOL;
      current.high = Math.max(current.high, price);
      if (event.is_buy) {
        current.net += volume;
        current.buys.push({ wallet: event.user, sol: volume });
        if (slot - tape.created <= EARLY_BUY_SLOTS) tape.earlyBuyers.add(event.user);
      } else {
        current.net -= volume;
        const drop = 1 - price / tape.price;
        if (drop > current.singleDrop) {
          current.singleDrop = drop;
          current.seller = event.user;
        }
        if (tape.creator && event.user === tape.creator && /^[1-9][0-9]*$/.test(event.token_amount)) {
          onCreatorSell?.(event);
        }
      }
      tape.price = price;
      tape.reserve = Number(event.real_quote_reserves) / SOL;
    }
    return touched;
  }

  features(slot: number, tape: Tape): number[] | undefined {
    const signal = tape.slots.at(-1)!;
    if (signal.singleDrop < 0.02) return;
    const buyers64 = new Set<string>();
    const walletVolume = new Map<string, number>();
    const sizes: number[] = [];
    let net32 = 0;
    let net64 = 0;
    let net128 = 0;
    let high64 = signal.high;
    let high128 = signal.high;
    let totalVolume = 0;
    let largestWallet = 0;
    for (const record of tape.slots) {
      const age = slot - record.slot;
      if (age > 0) {
        net128 += record.net;
        if (age <= 64) net64 += record.net;
        if (age <= 32) net32 += record.net;
      }
      high128 = Math.max(high128, record.high);
      if (age <= 64) high64 = Math.max(high64, record.high);
      for (const { wallet, sol } of record.buys) {
        if (age <= 64) buyers64.add(wallet);
        const total = (walletVolume.get(wallet) ?? 0) + sol;
        walletVolume.set(wallet, total);
        largestWallet = Math.max(largestWallet, total);
        totalVolume += sol;
        sizes.push(sol);
      }
    }
    sizes.sort((a, b) => a - b);
    const middle = Math.floor(sizes.length / 2);
    const median = sizes.length ? (sizes[middle] + sizes[Math.floor((sizes.length - 1) / 2)]) / 2 : 0;
    return [
      signal.singleDrop, 1 - tape.price / signal.open, 1 - tape.price / high64, 1 - tape.price / high128,
      net32, net64, net128, buyers64.size, walletVolume.size, totalVolume ? largestWallet / totalVolume : 0,
      median, slot - tape.created, tape.reserve, Number(signal.seller === tape.creator),
      Number(tape.earlyBuyers.has(signal.seller)), this.time - (this.lastCreate ?? this.time),
    ];
  }
}

export type Tree = number | [feature: number, cutoff: number, left: Tree, right: Tree];
export type ScoreModel = { intercept: number; trees: Tree[] };

export function treeValue(node: Tree, features: number[]): number {
  while (typeof node !== 'number') node = node[features[node[0]] <= node[1] ? 2 : 3];
  return node;
}

export function predict(model: ScoreModel, features: number[]): number {
  return model.trees.reduce((score, tree) => score + treeValue(tree, features), model.intercept);
}

// Fitted on W1–W3 after choosing the cutoff in held-out quarter replays.
const MODEL: ScoreModel = {
  intercept: -0.021743070411394196,
  trees: [
    [12, 72.70006388050001, [9, 0.07576268350790002, 0.0053278290337363, -0.0008001913199074998], -0.029362798965202042],
    [12, 72.70006388050001, [9, 0.08015758845252541, 0.004347371068375068, -0.0007501331589422748], -0.024958379120421734],
    [12, 72.4575827315, [8, 64.5, -0.000998110305607603, 0.0032668816858678557], -0.02040453480964539],
    [12, 71.18549696950001, [9, 0.07573991533716096, 0.004037855407893055, -0.0005326211325176559], [3, 0.056887246802955704, -0.030752849484468117, 0.002126476957229647]],
    [12, 72.70006388050001, [7, 188.5, 0.0004838208783516305, -0.017130288556635], -0.015670698252760504],
    [12, 71.18549696950001, [8, 67.5, -0.0008248752411520751, 0.002884598826831138], [3, 0.055505244035223944, -0.02497352637860949, 0.002586670318192833]],
    [12, 69.6410211525, [7, 188.5, 0.0005239181490678688, -0.014993435097164418], [2, 0.040571205863321635, -0.025321183904012622, 9.696620594350394e-05]],
    [11, 951.5, [3, 0.1675889503499644, 0.0033533487933991614, -0.002890294632097486], [8, 98.5, -0.001035278710056158, -0.027607475990984173]],
    [2, 0.04023201047354863, [12, 69.5833748, -0.0017885602070607251, -0.02105454204104123], [9, 0.08010855617122134, 0.003638661491366219, -0.000254782169859333]],
    [4, 14.306244216000001, [11, 951.5, 0.0020765966330264104, -0.0013834328916478144], [15, 11.5, -0.0010123580127518017, -0.013346187119025967]],
    [7, 188.5, [8, 151.5, -0.00025234820223021115, 0.005118382533042381], -0.012714533192032772],
    [2, 0.04023201047354863, [12, 69.2292496605, -0.0014471021252417816, -0.01740555658010274], [12, 25.6070326305, -0.002061095987799734, 0.0014231708172239075]],
    [4, 14.306244216000001, [11, 951.5, 0.0017286649565840964, -0.0011503879928575394], [9, 0.080496086185132, -0.01555827425700609, -0.0016293268624538895]],
    [6, 31.066748779, [12, 25.6070326305, -0.0018845268316679108, 0.0010817474964283102], [15, 12.5, 0.001915015173913024, -0.008985645244957345]],
    [4, 21.646041642500002, [12, 65.84078571699999, 0.0006183078605791593, -0.0035181728526378292], [9, 0.09649650259243776, -0.018594543823410623, -0.00132687401499418]],
    [2, 0.04023201047354863, [8, 132.5, -0.001175261692511828, -0.01581108101442771], [12, 72.13860296249999, 0.0003109531490280341, 0.011069486017581225]],
  ],
};
