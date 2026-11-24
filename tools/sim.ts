import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { PROTOCOL, type Bot, type ChainEvent, type Hello } from '../vendor/makefun-bot.ts';
import { replay, type Guardrails, type SlotEvents } from './replay.ts';

const kit = '/work/kit';
const solQuote = '11111111111111111111111111111111';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface Manifest {
  window: { start_slot: number; end_slot: number; first_block_time: number; last_block_time: number };
  universe: Hello['universe'];
  excluded_mints: { mint: string }[];
  files: { path: string; events: number }[];
}

interface Window {
  batches: SlotEvents[];
  endSlot: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function config(manifest: Manifest): { hello: Hello; guardrails: Guardrails } {
  const identity = readJson<{ seed_key?: string; bundle_sha256: string; phase: string; dataset_sha256: string }>(
    resolve(kit, 'kit.json'),
  );
  const seedKey = identity.seed_key ?? identity.bundle_sha256;
  const seedDigest = sha256(`agent-fun/seed/v1\0${seedKey}\0${identity.phase}\0${identity.dataset_sha256}`);

  // Read the kit's block-style harness mapping. The fields used here are JSON-compatible YAML scalars.
  const yaml = readFileSync(resolve(kit, 'competition.yaml'), 'utf8');
  const block = yaml.match(/^harness:\r?\n((?:[ \t].*\r?\n)+)/m)?.[1];
  if (!block) throw new Error('Missing harness mapping in competition.yaml');
  const fields = new Map<string, string>();
  const parents: string[] = [];
  for (const line of block.split('\n')) {
    const match = /^( +)([a-z_]+):(?:\s+(\S.*))?\s*$/.exec(line);
    if (!match) continue;
    const [, indent, key, value] = match;
    parents.length = indent.length / 2 - 1;
    if (value) fields.set([...parents, key].join('.'), value.trim());
    else parents.push(key);
  }
  function scalar<T extends string | number | boolean>(key: string, sample: T): T {
    const value = JSON.parse(fields.get(key) ?? 'null');
    if (typeof value !== typeof sample) throw new Error(`Missing or invalid harness.${key}`);
    return value as T;
  }
  if (fields.get('kind') !== 'pumpfun-replay/v2' || fields.get('protocol') !== PROTOCOL) {
    throw new Error('Expected a pumpfun-replay/v2 kit');
  }
  const hello: Hello = {
    type: 'hello',
    protocol: PROTOCOL,
    seed: BigInt(`0x${seedDigest.slice(0, 16)}`).toString(),
    universe: manifest.universe,
    capital: { lamports: scalar('capital.lamports', '') },
    latency_slots: scalar('latency_slots', 0),
    caps: {
      max_open_positions: scalar('caps.max_open_positions', 0),
      max_order_bps_of_real_reserve: scalar('caps.max_order_bps_of_real_reserve', 0),
      max_orders_per_batch: scalar('caps.max_orders_per_batch', 0),
      shorts: false,
      leverage: false,
    },
    fees: {
      protocol_bps_fallback: scalar('fees.protocol_bps_fallback', 0),
      creator_bps_fallback: scalar('fees.creator_bps_fallback', 0),
      base_fee_lamports: scalar('fees.base_fee_lamports', ''),
      priority_fee_lamports: scalar('fees.priority_fee_lamports', ''),
      failed_tx_bps: scalar('fees.failed_tx_bps', 0),
    },
  };
  if (scalar('caps.shorts', false) || scalar('caps.leverage', false)) {
    throw new Error('Expected caps with shorts and leverage disabled');
  }
  const threshold = 'guardrails.round_trips.min_buy_lamports';
  const drawdown = scalar('guardrails.max_drawdown', '');
  if (!/^\d+\.\d{9}$/.test(drawdown)) throw new Error('Expected a Fixed9 max drawdown');
  return {
    hello,
    guardrails: {
      minFills: scalar('guardrails.min_fills', 0),
      minCoins: scalar('guardrails.min_distinct_mints', 0),
      maxDrawdown: BigInt(drawdown.replace('.', '')),
      minRoundTripBuy: fields.has(threshold) ? BigInt(scalar(threshold, '')) : null,
    },
  };
}

function readWindows(data: string, manifest: Manifest, count: number, selected: Set<number>): Map<number, Window> {
  const { start_slot, end_slot, first_block_time, last_block_time } = manifest.window;
  // Start each split with its own cash and universe. A mint must have a create in the split.
  const windows = new Map<number, Window>();
  for (const index of selected) windows.set(index, { batches: [], endSlot: start_slot });
  const excluded = new Set(manifest.excluded_mints.map(({ mint }) => mint));
  const { modulus, residue } = manifest.universe.sample;
  const duration = last_block_time - first_block_time + 1;
  const mintedHere = new Set<string>();
  let slot = -1;
  let time = first_block_time;
  let index = 0;
  let window: Window | undefined;
  let batch: SlotEvents | undefined;

  for (const file of manifest.files) {
    const lines = gunzipSync(readFileSync(resolve(data, file.path))).toString('utf8').trimEnd().split('\n');
    if (lines.length !== file.events) throw new Error(`Unexpected event count in ${file.path}`);
    for (const line of lines) {
      const event = JSON.parse(line) as ChainEvent;
      if (event.slot !== slot) {
        if (event.slot < slot) throw new Error(`Dataset slots out of order at ${event.slot}`);
        slot = event.slot;
        time = Math.max(time, event.block_time ?? time);
        const nextIndex = Math.min(count - 1, Math.floor((time - first_block_time) * count / duration));
        if (nextIndex !== index) mintedHere.clear();
        index = nextIndex;
        window = windows.get(index);
        batch = undefined;
        if (window) window.endSlot = slot;
      }
      if (!window) continue;
      if (event.event === 'CreateEvent' && event.quote_mint === solQuote && !event.is_mayhem_mode &&
          !event.is_cashback_enabled && !excluded.has(event.mint) &&
          BigInt(`0x${sha256(event.mint)}`) % BigInt(modulus) === BigInt(residue)) {
        mintedHere.add(event.mint);
      }
      if (!mintedHere.has(event.mint)) continue;
      if (batch === undefined) {
        batch = { slot, events: [] };
        window.batches.push(batch);
      }
      batch.events.push(event);
    }
  }
  const last = windows.get(count - 1);
  if (last) last.endSlot = end_slot;
  return windows;
}

const usage = 'Usage: node tools/sim.ts --strategy strategies/<name>.ts [--data DIR] [--params JSON] [--window k/n | --windows n]';

function positiveInteger(value: string, flag: string): number {
  const n = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(n)) throw new Error(`Invalid ${flag}: ${value}`);
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      strategy: { type: 'string' },
      data: { type: 'string', default: resolve(kit, 'dataset') },
      params: { type: 'string', default: '{}' },
      window: { type: 'string' },
      windows: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.strategy) throw new Error(usage);
  if (values.window !== undefined && values.windows !== undefined) throw new Error('Use either --window or --windows');
  let count = 1;
  let selected = [0];
  if (values.windows !== undefined) {
    count = positiveInteger(values.windows, '--windows');
    selected = Array.from({ length: count }, (_, i) => i);
  } else if (values.window !== undefined) {
    const match = /^(\d+)\/(\d+)$/.exec(values.window);
    if (!match) throw new Error('--window must be k/n');
    count = positiveInteger(match[2], '--window denominator');
    const k = positiveInteger(match[1], '--window numerator');
    if (k > count) throw new Error('--window numerator must be no larger than its denominator');
    selected = [k - 1];
  }

  const params: unknown = JSON.parse(values.params);
  const { createStrategy } = await import(pathToFileURL(resolve(values.strategy)).href) as {
    createStrategy?: (params: unknown) => Bot;
  };
  if (typeof createStrategy !== 'function') throw new Error('Strategy must export createStrategy(params)');
  const manifest = readJson<Manifest>(resolve(values.data, 'manifest.json'));
  const { hello, guardrails } = config(manifest);
  const windows = readWindows(values.data, manifest, count, new Set(selected));

  const results: Awaited<ReturnType<typeof replay>>[] = [];
  for (const index of selected) {
    const { batches, endSlot } = windows.get(index)!;
    const metrics = await replay(createStrategy(structuredClone(params)), hello, guardrails, batches, endSlot);
    results.push(metrics);
    const label = values.windows === undefined ? {} : { window: `${index + 1}/${count}` };
    console.log(JSON.stringify({ ...label, ...metrics }));
  }
  if (values.windows !== undefined) {
    const pnl = results.map((row) => row.net_pnl_sol).sort((a, b) => a - b);
    const total = pnl.reduce((sum, value) => sum + value, 0);
    console.log(JSON.stringify({
      summary: {
        windows: count,
        total_net_pnl_sol: total,
        mean_net_pnl_sol: total / count,
        median_net_pnl_sol: (pnl[Math.floor((count - 1) / 2)] + pnl[Math.floor(count / 2)]) / 2,
        worst_net_pnl_sol: pnl[0],
        profitable_windows: pnl.filter((value) => value > 0).length,
        total_fills: results.reduce((sum, row) => sum + row.fills, 0),
        guardrails_ok_windows: results.filter((row) => row.guardrails_ok).length,
      },
    }));
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
