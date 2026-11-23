import {
  BotState,
  BPS,
  LAMPORTS_PER_SOL,
  type Account,
  type Batch,
  type Bot,
  type ChainEvent,
  type Done,
  type Fill,
  type Hello,
  type Order,
  type RejectReason,
} from '../vendor/makefun-bot.ts';

export interface Guardrails {
  minFills: number;
  minCoins: number;
  maxDrawdown: bigint; // Fixed point, scaled by 1e9.
  minRoundTripBuy: bigint | null;
}

export interface SlotEvents {
  slot: number;
  events: ChainEvent[];
}

type Reserves = { vq: bigint; vt: bigint; rq: bigint; rt: bigint };
type Rates = { protocol: bigint; creator: bigint; fallback: boolean };
type Curve = {
  recorded: Reserves;
  stateSlot: number;
  tradeSlot: number;
  tradeRates: Rates;
  complete: boolean;
  quoteIn: bigint;
  tokensOut: bigint;
};
type Position = { tokens: bigint; cost: bigint; bought: bigint };
type Pending = {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  slot: number;
  reason: RejectReason | null;
  decision?: Reserves;
  batchBuySpend: Map<string, bigint>;
};

const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;
const sol = (lamports: bigint) => Number(lamports) / Number(LAMPORTS_PER_SOL);
const fee = (quote: bigint, bps: bigint) => (quote * bps + BPS - 1n) / BPS;
const curveFee = (quote: bigint, rates: Rates) => fee(quote, rates.protocol) + fee(quote, rates.creator);

function adjusted(curve: Curve): Reserves {
  const { recorded, tokensOut, quoteIn } = curve;
  if (tokensOut === 0n && quoteIn === 0n) return recorded;
  // Shrink both offsets by the same fraction if either real reserve would go negative.
  let numerator = 1n;
  let denominator = 1n;
  if (tokensOut > recorded.rt) {
    numerator = recorded.rt;
    denominator = tokensOut;
  }
  if (quoteIn < 0n && recorded.rq * denominator < -quoteIn * numerator) {
    numerator = recorded.rq;
    denominator = -quoteIn;
  }
  const q = quoteIn * numerator / denominator;
  const t = tokensOut * numerator / denominator;
  return { vq: recorded.vq + q, vt: recorded.vt - t, rq: recorded.rq + q, rt: recorded.rt - t };
}

function quoteBuy(budget: bigint, reserves: Reserves, rates: Rates) {
  let q = budget * BPS / (BPS + rates.protocol + rates.creator);
  let fees = curveFee(q, rates);
  q -= max(0n, q + fees - budget);
  let tokens = q <= 1n ? 0n : (q - 1n) * reserves.vt / (reserves.vq + q - 1n);
  if (tokens > reserves.rt) {
    tokens = reserves.rt;
    q = tokens === 0n ? 0n : tokens * reserves.vq / (reserves.vt - tokens) + 1n;
    fees = curveFee(q, rates);
  }
  return { q, tokens, fees, paid: q + fees };
}

const sellGross = (tokens: bigint, s: Reserves) => tokens * s.vq / (s.vt + tokens);
const rngStep = 0x9e3779b97f4a7c15n;
const failKeyDomain = 0x6661696c2d6b6579n;
const failedTxDomain = 0x6661696c65642d74n;

function mix64(input: bigint): bigint {
  let x = BigInt.asUintN(64, input);
  x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n);
  x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn);
  return x ^ (x >> 31n);
}

const foldKey = (key: bigint, part: bigint) => mix64((key ^ part) + rngStep);
const domainKey = (seed: bigint, domain: bigint) => foldKey(mix64(seed + rngStep), domain);

class Market {
  private readonly curves = new Map<string, Curve>();
  private readonly positions = new Map<string, Position>();
  private readonly perCoin = new Map<string, bigint>();
  private readonly filledCoins = new Set<string>();
  private readonly roundTripCoins = new Set<string>();
  private readonly seenIds = new Set<string>();
  private pending: Pending[] = [];
  private fills: Fill[] = [];
  private fillCount = 0;
  private closeCount = 0;
  private fees = 0n;
  private readonly start: bigint;
  private cash: bigint;
  private peak: bigint;
  private drawdown = 0n;
  private readonly failureStream: bigint;
  private readonly txFee: bigint;
  private readonly fallbackRates: Rates;

  private readonly hello: Hello;
  private readonly rules: Guardrails;

  constructor(hello: Hello, rules: Guardrails) {
    this.hello = hello;
    this.rules = rules;
    this.start = BigInt(hello.capital.lamports);
    this.cash = this.peak = this.start;
    this.txFee = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
    this.fallbackRates = {
      protocol: BigInt(hello.fees.protocol_bps_fallback),
      creator: BigInt(hello.fees.creator_bps_fallback),
      fallback: true,
    };
    const publicFailKey = domainKey(BigInt(hello.seed), failKeyDomain);
    this.failureStream = domainKey(publicFailKey, failedTxDomain);
  }

  batch(seq: number, { slot, events }: SlotEvents): Batch {
    // A gap fills against earlier records. A populated landing slot fills after all its records.
    this.resolveThrough(slot - 1);
    const completed: string[] = [];
    for (const event of events) {
      const curve = this.curves.get(event.mint);
      if (event.event === 'CreateEvent') {
        this.curves.set(event.mint, {
          recorded: {
            vq: BigInt(event.virtual_quote_reserves), vt: BigInt(event.virtual_token_reserves),
            rq: 0n, rt: BigInt(event.real_token_reserves),
          },
          stateSlot: slot,
          tradeSlot: -1,
          tradeRates: this.fallbackRates,
          complete: false,
          quoteIn: 0n,
          tokensOut: 0n,
        });
      } else if (!curve) {
        throw new Error(`Missing create for ${event.mint} at slot ${slot}`);
      } else if (event.event === 'TradeEvent') {
        curve.recorded = {
          vq: BigInt(event.virtual_quote_reserves), vt: BigInt(event.virtual_token_reserves),
          rq: BigInt(event.real_quote_reserves), rt: BigInt(event.real_token_reserves),
        };
        curve.stateSlot = curve.tradeSlot = slot;
        curve.tradeRates = event.fee_basis_points === '0' ? this.fallbackRates : {
          protocol: BigInt(event.fee_basis_points),
          creator: BigInt(event.creator_fee_basis_points),
          fallback: false,
        };
      } else {
        curve.complete = true;
        completed.push(event.mint);
      }
    }
    for (const mint of completed) if (this.positions.has(mint)) this.close(mint, slot, 'complete');
    this.resolveThrough(slot);

    const marked = new Set(this.positions.keys());
    for (const { order } of this.pending) if (this.curves.has(order.mint)) marked.add(order.mint);
    const marks = [...marked].sort().map((mint) => {
      const curve = this.curves.get(mint)!;
      const { vq, vt, rq, rt } = adjusted(curve);
      return {
        mint, slot: curve.stateSlot, virtual_token_reserves: String(vt), virtual_quote_reserves: String(vq),
        real_token_reserves: String(rt), real_quote_reserves: String(rq),
      };
    });
    let equity = this.cash;
    for (const [mint, position] of this.positions) {
      const { net } = this.liquidation(this.curves.get(mint)!, position.tokens);
      equity += max(0n, net);
    }
    this.markEquity(equity);
    const fills = this.fills;
    this.fills = [];
    return { type: 'batch', seq, slot, events, marks, fills, account: this.account() };
  }

  submit(seq: number, slot: number, orders: Order[]): void {
    const batchBuySpend = new Map<string, bigint>();
    for (const [index, order] of orders.entries()) {
      const curve = this.curves.get(order.mint);
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      let reason: RejectReason | null = null;
      if (this.seenIds.has(order.client_id)) reason = 'duplicate_client_id';
      else if (amount === '0') reason = 'zero_amount';
      else if (!curve) reason = 'not_in_universe';
      this.seenIds.add(order.client_id);
      this.pending.push({
        order: { ...order }, seq, index, decidedSlot: slot, slot: slot + this.hello.latency_slots,
        reason, decision: curve && adjusted(curve), batchBuySpend,
      });
    }
  }

  private resolveThrough(slot: number): void {
    let count = 0;
    while (count < this.pending.length && this.pending[count].slot <= slot) {
      this.resolve(this.pending[count++]);
    }
    if (count > 0) this.pending = this.pending.slice(count);
  }

  private resolve(pending: Pending): void {
    const { order, decision, reason, batchBuySpend, seq, index, slot, decidedSlot } = pending;
    const { mint, side } = order;
    const fill: Fill = {
      client_id: order.client_id, mint, side, status: 'rejected', reason: null, decided_slot: decidedSlot, slot,
      quote_lamports: '0', token_amount: '0', fee_lamports: '0', tx_fee_lamports: '0', fee_fallback: false,
    };
    this.fills.push(fill);
    if (reason) {
      fill.reason = reason;
      return;
    }
    const curve = this.curves.get(mint)!;
    if (curve.complete) {
      fill.reason = 'token_complete';
      return;
    }
    const reserves = adjusted(curve);
    const rates = curve.tradeSlot === slot ? curve.tradeRates : this.fallbackRates;
    const position = this.positions.get(mint);
    const acceptable = BPS - BigInt(order.max_slippage_bps);
    let q: bigint;
    let tokens: bigint;
    let fees: bigint;
    let quote: bigint;

    if (side === 'buy') {
      const budget = BigInt(order.quote_lamports);
      if (!position && this.positions.size >= this.hello.caps.max_open_positions) {
        fill.reason = 'max_open_positions';
        return;
      }
      const spent = (batchBuySpend.get(mint) ?? 0n) + budget;
      if (spent * BPS > decision!.rq * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) {
        fill.reason = 'max_order_size';
        return;
      }
      batchBuySpend.set(mint, spent);
      ({ q, tokens, fees, paid: quote } = quoteBuy(budget, reserves, rates));
      if (tokens === 0n) fill.reason = 'zero_amount';
      else if (tokens * BPS < quoteBuy(budget, decision!, rates).tokens * acceptable) fill.reason = 'max_slippage';
      else if (this.cash < budget + this.txFee) fill.reason = 'insufficient_cash';
    } else {
      tokens = BigInt(order.token_amount);
      if (!position || position.tokens < tokens) {
        fill.reason = 'insufficient_tokens';
        return;
      }
      q = sellGross(tokens, reserves);
      fees = curveFee(q, rates);
      quote = q - fees;
      const expected = sellGross(tokens, decision!);
      if (q > reserves.rq) fill.reason = 'max_order_size';
      else if (quote <= 0n) fill.reason = 'zero_amount';
      else if (quote * BPS < (expected - curveFee(expected, rates)) * acceptable) fill.reason = 'max_slippage';
      else if (this.cash < this.txFee) fill.reason = 'insufficient_cash';
    }
    if (fill.reason) return;

    fill.tx_fee_lamports = String(this.txFee);
    const draw = foldKey(foldKey(this.failureStream, BigInt(seq)), BigInt(index));
    if (draw % BPS < BigInt(this.hello.fees.failed_tx_bps)) {
      fill.status = 'failed';
      this.cashFlow(mint, -this.txFee, 0n);
      return;
    }

    if (side === 'buy') {
      const held = position ?? { tokens: 0n, cost: 0n, bought: 0n };
      held.tokens += tokens;
      held.cost += quote;
      held.bought += quote;
      this.positions.set(mint, held);
      curve.quoteIn += q;
      curve.tokensOut += tokens;
      this.cashFlow(mint, -quote - this.txFee, fees);
    } else {
      const held = position!;
      held.cost -= held.cost * tokens / held.tokens;
      held.tokens -= tokens;
      if (held.tokens === 0n) this.endPosition(mint, held);
      curve.quoteIn -= q;
      curve.tokensOut -= tokens;
      this.cashFlow(mint, quote - this.txFee, fees);
    }
    this.fillCount++;
    this.filledCoins.add(mint);
    Object.assign(fill, {
      status: 'filled', quote_lamports: String(quote), token_amount: String(tokens),
      fee_lamports: String(fees), fee_fallback: rates.fallback,
    });
  }

  private liquidation(curve: Curve, tokens: bigint) {
    const s = adjusted(curve);
    const q = min(sellGross(tokens, s), s.rq);
    const fees = curveFee(q, curve.tradeRates);
    return { q, fees, net: q - fees - this.txFee };
  }

  private close(mint: string, slot: number, kind: 'complete' | 'flatten'): void {
    const position = this.positions.get(mint)!;
    const curve = this.curves.get(mint)!;
    const { q, fees, net } = this.liquidation(curve, position.tokens);
    const sold = net > 0n;
    if (sold) {
      curve.quoteIn -= q;
      curve.tokensOut -= position.tokens;
      this.cashFlow(mint, net, fees);
    }
    this.endPosition(mint, position);
    this.fills.push({
      client_id: `_${sold ? kind : 'writeoff'}_${this.closeCount++}`, mint, side: 'sell', status: 'filled',
      reason: null, decided_slot: slot, slot, quote_lamports: sold ? String(q - fees) : '0',
      token_amount: String(position.tokens), fee_lamports: sold ? String(fees) : '0',
      tx_fee_lamports: sold ? String(this.txFee) : '0', fee_fallback: sold && curve.tradeRates.fallback,
    });
  }

  private endPosition(mint: string, position: Position): void {
    this.positions.delete(mint);
    if (this.rules.minRoundTripBuy === null || position.bought >= this.rules.minRoundTripBuy) {
      this.roundTripCoins.add(mint);
    }
  }

  private cashFlow(mint: string, delta: bigint, curveFees: bigint): void {
    this.cash += delta;
    this.fees += curveFees + this.txFee;
    this.perCoin.set(mint, (this.perCoin.get(mint) ?? 0n) + delta);
  }

  private markEquity(equity: bigint): void {
    this.peak = max(this.peak, equity);
    if (this.peak > 0n) {
      this.drawdown = max(this.drawdown, (this.peak - equity) * LAMPORTS_PER_SOL / this.peak);
    }
  }

  private account(): Account {
    return {
      cash_lamports: String(this.cash),
      positions: [...this.positions.keys()].sort().map((mint) => {
        const { tokens, cost } = this.positions.get(mint)!;
        return { mint, token_amount: String(tokens), cost_lamports: String(cost) };
      }),
    };
  }

  finish(seq: number, endSlot: number): Done {
    this.resolveThrough(endSlot);
    // After-end rejections and terminal closes have no subsequent batch to deliver them.
    this.pending = [];
    for (const mint of [...this.positions.keys()].sort()) this.close(mint, endSlot, 'flatten');
    this.markEquity(this.cash);
    return { type: 'done', seq, reason: 'end_of_data', account: this.account() };
  }

  metrics() {
    const net = this.cash - this.start;
    const gains = [...this.perCoin.values()].filter((pnl) => pnl > 0n).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
    const totalGains = gains.reduce((sum, value) => sum + value, 0n);
    const topThree = gains.slice(0, 3).reduce((sum, value) => sum + value, 0n);
    const coinCount = this.rules.minRoundTripBuy === null ? this.filledCoins.size : this.roundTripCoins.size;
    return {
      net_pnl_sol: sol(net),
      fills: this.fillCount,
      coins: this.filledCoins.size,
      round_trip_coins: this.roundTripCoins.size,
      max_dd: sol(this.drawdown),
      fees_sol: sol(this.fees),
      top3_share: totalGains === 0n ? 0 : Number(topThree) / Number(totalGains),
      pnl_ex_top3_sol: sol(net - topThree),
      guardrails_ok: this.fillCount >= this.rules.minFills && coinCount >= this.rules.minCoins &&
        this.drawdown <= this.rules.maxDrawdown,
    };
  }
}

export async function replay(
  bot: Bot, hello: Hello, guardrails: Guardrails, batches: Iterable<SlotEvents>, endSlot: number,
) {
  const market = new Market(hello, guardrails);
  const state = new BotState(structuredClone(hello));
  await bot.onHello?.(state);
  let seq = 0;
  for (const records of batches) {
    const batch = market.batch(seq, records);
    state.applyBatch(batch);
    const orders = state.toOrders(await bot.onBatch(state, batch));
    market.submit(seq, records.slot, orders);
    state.recordOrders(orders);
    seq++;
  }
  const done = market.finish(seq, endSlot);
  state.applyDone(done);
  await bot.onDone?.(state, done);
  return market.metrics();
}
