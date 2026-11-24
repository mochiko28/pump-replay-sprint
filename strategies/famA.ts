import { BPS, LAMPORTS_PER_SOL, type Bot, type OrderInput } from '../vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  maxAgeSlots: 4,
  minBuyers: 5,
  minBuySlots: 2,
  minBuySellRatio: 3,
  maxWalletShare: 0.5,
  minPriceRise: 0.08,
  minReserveSol: 3,
  maxReserveSol: 14,
  buySlippageBps: 1500,
  maxBuys: 2,
  stopLoss: 0.18,
  trail: 0.04,
  holdSlots: 8,
};

type Launch = {
  slot: number;
  creator: string;
  initialPrice: number;
  price: number;
  walletBuys: Map<string, number>;
  buyVolume: number;
  sellVolume: number;
  largestWalletBuy: number;
  buyerCount: number;
  buySlots: number;
  lastBuySlot: number;
  fills: number;
};

type Position = {
  firstFillSlot: number;
  buyFees: bigint;
  peakReturn: number;
  exiting: boolean;
};

const MIN_BUY = 10_000_010n; // Leave room for rounding at the 0.01 SOL round-trip threshold.
const MIN_BUYER_VOLUME = 20_000_000;

export function createStrategy(params: Partial<typeof DEFAULT_PARAMS> = {}): Bot {
  const p = { ...DEFAULT_PARAMS, ...params };
  const launches = new Map<string, Launch>();
  const positions = new Map<string, Position>();
  let sellFeeBps = 0n;
  let txFee = 0n;

  return {
    onHello(state) {
      const { fees } = state.hello;
      sellFeeBps = BigInt(fees.protocol_bps_fallback + fees.creator_bps_fallback);
      txFee = state.txFeeLamports();
    },

    onBatch(state, batch) {
      const { slot } = batch;
      for (const fill of batch.fills) {
        if (fill.status !== 'filled') continue;
        if (fill.side === 'sell') {
          if (!state.positions.has(fill.mint)) {
            positions.delete(fill.mint);
            launches.delete(fill.mint);
          }
          continue;
        }
        const buyFee = BigInt(fill.tx_fee_lamports);
        const position = positions.get(fill.mint);
        if (position) {
          position.buyFees += buyFee;
          // The add changes the blended cost. Rebase the trail and keep the original deadline.
          position.peakReturn = 0;
        } else {
          positions.set(fill.mint, {
            firstFillSlot: fill.slot, buyFees: buyFee, peakReturn: 0, exiting: false,
          });
        }
        const launch = launches.get(fill.mint);
        if (launch && ++launch.fills >= p.maxBuys) launches.delete(fill.mint);
      }

      const touched = new Set<string>();
      for (const event of batch.events) {
        if (event.event === 'CreateEvent') {
          const price = Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
          launches.set(event.mint, {
            slot, creator: event.creator, initialPrice: price, price, walletBuys: new Map(),
            buyVolume: 0, sellVolume: 0, largestWalletBuy: 0, buyerCount: 0,
            buySlots: 0, lastBuySlot: -1, fills: 0,
          });
          continue;
        }
        const launch = launches.get(event.mint);
        if (!launch) continue;
        if (event.event === 'CompleteEvent' || slot - launch.slot > p.maxAgeSlots) {
          launches.delete(event.mint);
          continue;
        }
        launch.price = Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves);
        const volume = Number(event.quote_amount);
        if (event.is_buy) {
          const previous = launch.walletBuys.get(event.user) ?? 0;
          const total = previous + volume;
          launch.walletBuys.set(event.user, total);
          launch.buyVolume += volume;
          launch.largestWalletBuy = Math.max(launch.largestWalletBuy, total);
          if (event.user !== launch.creator) {
            if (previous < MIN_BUYER_VOLUME && total >= MIN_BUYER_VOLUME) launch.buyerCount++;
            if (volume >= MIN_BUYER_VOLUME && launch.lastBuySlot !== slot) {
              launch.buySlots++;
              launch.lastBuySlot = slot;
            }
          }
        } else {
          launch.sellVolume += volume;
        }
        touched.add(event.mint);
      }

      const pending = new Set([...state.pending.values()].map(({ order }) => order.mint));
      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      let cash = state.freeCashLamports();

      for (const [mint, holding] of state.positions) {
        const position = positions.get(mint);
        const curve = state.curves.get(mint);
        if (!position || !curve || curve.complete) continue;
        const gross = holding.token_amount * curve.virtual_quote_reserves
          / (curve.virtual_token_reserves + holding.token_amount);
        const sellable = gross < curve.real_quote_reserves ? gross : curve.real_quote_reserves;
        const net = sellable * (BPS - sellFeeBps) / BPS - txFee;
        const proceeds = Number(net) / Number(holding.cost_lamports + position.buyFees);
        position.peakReturn = Math.max(position.peakReturn, proceeds);
        position.exiting ||= proceeds <= 1 - p.stopLoss
          || (position.peakReturn > 1 && proceeds <= position.peakReturn * (1 - p.trail))
          || slot - position.firstFillSlot >= p.holdSlots;
        if (!position.exiting || pending.has(mint) || cash < txFee || orders.length >= maxOrders) continue;
        orders.push({ mint, side: 'sell', token_amount: holding.token_amount, max_slippage_bps: 10_000 });
        cash -= txFee;
      }

      const candidates: { mint: string; cap: bigint; score: number }[] = [];
      for (const mint of touched) {
        const launch = launches.get(mint);
        if (!launch || pending.has(mint) || positions.get(mint)?.exiting || launch.fills >= p.maxBuys) continue;
        if (launch.buyerCount < p.minBuyers || launch.buySlots < p.minBuySlots
          || launch.buyVolume < p.minBuySellRatio * launch.sellVolume
          || launch.largestWalletBuy > p.maxWalletShare * launch.buyVolume) continue;

        const rise = launch.price / launch.initialPrice - 1;
        if (rise < p.minPriceRise) continue;
        const curve = state.curves.get(mint);
        if (!curve) continue;
        const reserveSol = Number(curve.real_quote_reserves) / Number(LAMPORTS_PER_SOL);
        if (reserveSol < p.minReserveSol || reserveSol > p.maxReserveSol) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY) continue;
        candidates.push({ mint, cap, score: rise * Math.sqrt(launch.buyerCount) });
      }

      candidates.sort((a, b) => b.score - a.score);
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const { mint, cap } of candidates) {
        const available = cash - 2n * txFee; // Allow for this buy and keep one sell fee in cash.
        if (orders.length >= maxOrders || available < MIN_BUY) break;
        const held = state.positions.has(mint);
        if (!held && room <= 0) continue;
        const budget = cap < available ? cap : available;
        orders.push({ mint, side: 'buy', quote_lamports: budget, max_slippage_bps: p.buySlippageBps });
        cash -= budget + txFee;
        if (!held) room--;
      }
      return orders;
    },

    onDone() {
      launches.clear();
      positions.clear();
    },
  };
}
