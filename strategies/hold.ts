import type { Bot } from '../vendor/makefun-bot.ts';

export function createStrategy(_params: unknown = {}): Bot {
  return {
    onHello() {},
    onBatch() {},
    onDone() {},
  };
}
