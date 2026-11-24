import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createStrategy as createCandidate, DEFAULT_PARAMS } from '../strategies/famC_m5.ts';
import type { Bot } from '../vendor/makefun-bot.ts';
import type { replay } from './replay.ts';

type Metrics = Awaited<ReturnType<typeof replay>>;
type Trial = { param: string; scale: number; params: Partial<typeof DEFAULT_PARAMS> };
type Rejections = { rejected: number; reasons: Record<string, { buy: number; sell: number }>; failed: number };
type SplitSummary = {
  windows: number;
  total_net_pnl_sol: number;
  worst_net_pnl_sol: number;
  profitable_windows: number;
};

const repo = fileURLToPath(new URL('../', import.meta.url));
const candidate = 'strategies/famC_m5.ts';

// The full-data replay imports this wrapper to count order outcomes through the bot API.
export function createStrategy(params: Partial<typeof DEFAULT_PARAMS>): Bot {
  const bot = createCandidate(params);
  const counts: Rejections = { rejected: 0, reasons: {}, failed: 0 };
  return {
    ...bot,
    onBatch(state, batch) {
      for (const fill of batch.fills) {
        if (fill.status === 'rejected') {
          const reason = fill.reason ?? 'unspecified';
          counts.rejected++;
          const sides = counts.reasons[reason] ??= { buy: 0, sell: 0 };
          sides[fill.side]++;
        } else if (fill.status === 'failed') {
          counts.failed++;
        }
      }
      return bot.onBatch(state, batch);
    },
    async onDone(state, done) {
      // sim.ts does not deliver a final batch after settling pending orders.
      if (state.pending.size > 0) {
        throw new Error(`Cannot count terminal outcomes for ${state.pending.size} pending orders`);
      }
      await bot.onDone?.(state, done);
      console.log(JSON.stringify({ rejections: counts }));
    },
  };
}

async function simulate(strategy: string, params: Trial['params'], ...args: string[]) {
  const command = ['tools/sim.ts', '--strategy', strategy, '--params', JSON.stringify(params), ...args];
  const directory = mkdtempSync(join(tmpdir(), 'robust-famC-'));
  const outPath = join(directory, 'sim.jsonl');
  const stdout = openSync(outPath, 'w');
  try {
    const child = spawn(process.execPath, command, { cwd: repo, stdio: ['ignore', stdout, 'inherit'] });
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${command.join(' ')} exited with ${signal ?? code}`);
    return readFileSync(outPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } finally {
    closeSync(stdout);
    rmSync(directory, { recursive: true });
  }
}

async function split(params: Trial['params'], count: number) {
  const lines = await simulate(candidate, params, '--windows', String(count));
  const summary = lines.pop()?.summary as SplitSummary | undefined;
  if (summary?.windows !== count || lines.length !== count) {
    throw new Error(`Expected all ${count} windows for ${JSON.stringify(params)}`);
  }
  return { windows: lines as (Metrics & { window: string })[], summary };
}

async function evaluate(trial: Trial) {
  return { ...trial, four: await split(trial.params, 4), eight: await split(trial.params, 8) };
}

async function main() {
  const { values } = parseArgs({ options: { json: { type: 'boolean' } } });
  const trials: Trial[] = [{ param: 'Parent', scale: 1, params: {} }];
  for (const [param, baseline] of Object.entries(DEFAULT_PARAMS)) {
    if (typeof baseline !== 'number') continue;
    for (const percent of [70, 85, 115, 130]) {
      trials.push({ param, scale: percent / 100, params: { [param]: baseline * percent / 100 } });
    }
  }

  const results: Awaited<ReturnType<typeof evaluate>>[] = [];
  for (let i = 0; i < trials.length; i += 4) {
    results.push(...await Promise.all(trials.slice(i, i + 4).map(evaluate)));
  }
  const [audit, fullMetrics] = await simulate('tools/robust_famC.ts', {});
  if (values.json) {
    console.log(JSON.stringify({ defaults: DEFAULT_PARAMS, results, fullMetrics, ...audit }, null, 2));
    return;
  }

  console.log('| Parameter | Scale | 4-window sum (SOL) | Worst window (SOL) | Profitable 8-split slices |');
  console.log('|---|---:|---:|---:|---:|');
  for (const { param, scale, four, eight } of results) {
    const { total_net_pnl_sol, worst_net_pnl_sol } = four.summary;
    console.log(`| ${param} | ${scale.toFixed(2)} | ${total_net_pnl_sol.toFixed(6)} | ${worst_net_pnl_sol.toFixed(6)} | ${eight.summary.profitable_windows}/8 |`);
  }
  console.log('\n| Parent window | Net PnL (SOL) | Fills | Coins | Qualifying round trips (coins) | Max drawdown | Fees (SOL) |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const row of results[0].four.windows) {
    console.log(`| ${row.window} | ${row.net_pnl_sol.toFixed(6)} | ${row.fills} | ${row.coins} | ${row.round_trip_coins} | ${(100 * row.max_dd).toFixed(3)}% | ${row.fees_sol.toFixed(6)} |`);
  }
  console.log('\nParent full-dataset metrics', fullMetrics);
  console.log('Parent full-dataset order outcomes', audit.rejections);
}

if (import.meta.main) await main();
