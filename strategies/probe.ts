import type { Bot, OrderInput } from '../vendor/makefun-bot.ts';

export function createStrategy(params: { minTrades?: number; holdSlots?: number } = {}): Bot {
  const { minTrades = 3, holdSlots = 30 } = params;
  const spend = 50_000_000n;
  const attempted = new Set<string>();
  const opened = new Map<string, number>();

  return {
    onBatch(state, batch) {
      for (const fill of batch.fills) {
        if (fill.status === 'filled' && fill.side === 'buy') opened.set(fill.mint, fill.slot);
        if (!state.positions.has(fill.mint)) opened.delete(fill.mint);
      }

      const pendingMints = new Set([...state.pending.values()].map(({ order }) => order.mint));
      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      for (const [mint, position] of state.positions) {
        if (orders.length === maxOrders) break;
        const boughtAt = opened.get(mint);
        if (boughtAt === undefined || batch.slot - boughtAt < holdSlots || pendingMints.has(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 });
      }

      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      let cash = state.freeCashLamports() - BigInt(orders.length) * state.txFeeLamports();
      const buyCost = spend + state.txFeeLamports();
      for (const event of batch.events) {
        if (room === 0 || orders.length === maxOrders || cash < buyCost) break;
        if (event.event !== 'TradeEvent' || attempted.has(event.mint)) continue;
        if ((state.curves.get(event.mint)?.trades ?? 0) < minTrades || state.maxBuyLamports(event.mint) < spend) continue;
        attempted.add(event.mint);
        orders.push({ side: 'buy', mint: event.mint, quote_lamports: spend, max_slippage_bps: 10_000 });
        room--;
        cash -= buyCost;
      }
      return orders;
    },
  };
}
