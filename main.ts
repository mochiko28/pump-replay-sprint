import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategies/current.ts';

await runBot(createStrategy());
