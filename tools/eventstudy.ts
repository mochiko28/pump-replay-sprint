import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PROTOCOL, type Bot, type ChainEvent, type Hello } from '../vendor/makefun-bot.ts';
import { replay, type Guardrails, type SlotEvents } from './replay.ts';
import {
  createScoredStrategy, DEFAULT_PARAMS, EntryFeatures, FEATURE_NAMES, predict, treeValue, type ScoreModel, type Tree,
} from '../strategies/famG.ts';

const kit = '/work/kit';
const data = resolve(kit, 'dataset');
const output = '/work/.tmp/es.csv';
const SOL = 1_000_000_000;
const RESERVE_FEATURE = FEATURE_NAMES.indexOf('real_reserve_sol');
const MAX_ENTRY_RESERVE_SOL = 45; // 1% of the reserve funds the 0.45 SOL strategy budget.
const TREES = 16;
const MIN_LEAF = 32;
const LEARNING_RATE = 0.15;
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


type Trade = Extract<ChainEvent, { event: 'TradeEvent' }>;
type Create = Extract<ChainEvent, { event: 'CreateEvent' }>;
type Row = { quarter: number; slot: number; mint: string; features: number[]; label: number | null };
type Metrics = Awaited<ReturnType<typeof replay>>;

async function eventRows(quarter: number, window: Window, hello: Hello, guardrails: Guardrails): Promise<Row[]> {
  const rows: Row[] = [];
  const study = new EntryFeatures();
  const creates = new Map<string, Create>();
  const trades = new Map<string, Trade>();
  const eventsByMint = new Map<string, Map<number, ChainEvent[]>>();
  for (const { slot, events } of window.batches) {
    for (const event of events) {
      let bySlot = eventsByMint.get(event.mint);
      if (!bySlot) eventsByMint.set(event.mint, bySlot = new Map());
      let mintEvents = bySlot.get(slot);
      if (!mintEvents) bySlot.set(slot, mintEvents = []);
      // The study uses the requested fixed 125 bps fee on both legs.
      mintEvents.push(event.event === 'TradeEvent' ? {
        ...event, fee_basis_points: '95', creator_fee_basis_points: '30',
      } : event);
    }
  }
  const labelHello = {
    ...hello,
    fees: { ...hello.fees, protocol_bps_fallback: 95, creator_bps_fallback: 30, failed_tx_bps: 0 },
  };

  for (const [i, batch] of window.batches.entries()) {
    const { slot, events } = batch;
    const touched = study.update(slot, events);
    const completed = new Set<string>();
    for (const event of events) {
      if (event.event === 'CreateEvent') creates.set(event.mint, event);
      else if (event.event === 'TradeEvent') trades.set(event.mint, event);
      else completed.add(event.mint);
    }
    for (const [mint, tape] of touched) {
      const features = study.features(slot, tape);
      if (!features) continue;
      const label = completed.has(mint) ? null : await tradeLabel(
        window, i, creates.get(mint)!, trades.get(mint)!, eventsByMint.get(mint)!, labelHello, guardrails,
      );
      rows.push({ quarter, slot, mint, features, label });
    }
  }
  return rows;
}

async function tradeLabel(
  window: Window, start: number, create: Create, lastTrade: Trade, bySlot: Map<number, ChainEvent[]>,
  hello: Hello, guardrails: Guardrails,
): Promise<number | null> {
  const mint = create.mint;
  const slot = window.batches[start].slot;
  const budget = Math.min(SOL, Math.floor(Number(lastTrade.real_quote_reserves) * hello.caps.max_order_bps_of_real_reserve / 10_000));
  if (budget === 0 || slot + hello.latency_slots > window.endSlot) return null;

  let buyCost = 0;
  let entrySlot = 0;
  let done = false;
  let creatorExit = false;
  let finalCash = Number(hello.capital.lamports);
  const bot: Bot = {
    onBatch(state, batch) {
      if (batch.slot === slot) {
        return [{ side: 'buy', mint, quote_lamports: budget, max_slippage_bps: DEFAULT_PARAMS.buySlippageBps }];
      }
      for (const fill of batch.fills) {
        if (fill.side === 'buy' && fill.status !== 'filled') done = true;
        if (fill.side === 'buy' && fill.status === 'filled') {
          buyCost = Number(fill.quote_lamports) + Number(fill.tx_fee_lamports);
          entrySlot = fill.slot;
        }
        if (fill.side === 'sell' && fill.status === 'filled') done = true;
      }
      const position = state.positions.get(mint);
      if (!position) return [];
      creatorExit ||= batch.events.some((event) =>
        event.event === 'TradeEvent' && !event.is_buy && create.creator && event.user === create.creator &&
        event.slot > entrySlot && /^[1-9][0-9]*$/.test(event.token_amount));
      if (state.pending.size) return [];
      const mark = batch.marks[0];
      const tokens = Number(position.token_amount);
      const gross = Math.min(Number(mark.real_quote_reserves),
        tokens * Number(mark.virtual_quote_reserves) / (Number(mark.virtual_token_reserves) + tokens));
      const netReturn = (gross * 0.9875 - Number(state.txFeeLamports())) / buyCost - 1;
      if (creatorExit || batch.slot >= entrySlot + DEFAULT_PARAMS.holdSlots || Math.abs(netReturn) >= DEFAULT_PARAMS.exitMove) {
        return [{ side: 'sell', mint, token_amount: position.token_amount, max_slippage_bps: 10_000 }];
      }
      return [];
    },
    onDone(state) {
      finalCash = Number(state.cash);
    },
  };

  function* batches(): Iterable<SlotEvents> {
    yield { slot, events: [create, { ...lastTrade, fee_basis_points: '95', creator_fee_basis_points: '30' }] };
    // Keep empty-for-this-mint batches: famC can act at every sampled market batch.
    for (let i = start + 1; i < window.batches.length && !done; i++) {
      const { slot } = window.batches[i];
      yield { slot, events: bySlot.get(slot) ?? [] };
    }
    if (!done && window.batches.at(-1)!.slot < window.endSlot) yield { slot: window.endSlot, events: [] };
  }
  await replay(bot, hello, guardrails, batches(), window.endSlot);
  // A rejected buy made no cash flow or position.
  return buyCost ? (finalCash - Number(hello.capital.lamports)) / buyCost : 0;
}

type Observation = Row & { label: number };
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;

function fitTrees(rows: Observation[]): ScoreModel {
  // Weight by squared executable notional to emphasize signals that can move portfolio PnL.
  const weights = rows.map((row) =>
    (Math.min(MAX_ENTRY_RESERVE_SOL, row.features[RESERVE_FEATURE]) / MAX_ENTRY_RESERVE_SOL) ** 2);
  const baseline = rows.reduce((sum, row, i) => sum + row.label * weights[i], 0) /
    weights.reduce((sum, weight) => sum + weight, 0);
  const residuals = rows.map((row) => row.label - baseline);
  const features = rows.map((row) => row.features);
  const sorted = FEATURE_NAMES.map((_, feature) =>
    rows.map((_, i) => i).sort((a, b) => features[a][feature] - features[b][feature]));

  function fitNode(ordered: number[][], depth: number): Tree {
    const n = ordered[0].length;
    const total = ordered[0].reduce((sum, i) => sum + residuals[i] * weights[i], 0);
    const weight = ordered[0].reduce((sum, i) => sum + weights[i], 0);
    const leaf = weight > 0 ? total * LEARNING_RATE / weight : 0;
    if (depth === 0 || n < 2 * MIN_LEAF) return leaf;
    let best = { gain: 0, feature: 0, cutoff: 0 };
    for (const [feature, indices] of ordered.entries()) {
      let left = 0;
      let leftWeight = 0;
      for (let j = 0; j < n - MIN_LEAF; j++) {
        left += residuals[indices[j]] * weights[indices[j]];
        leftWeight += weights[indices[j]];
        const k = j + 1;
        const value = features[indices[j]][feature];
        const next = features[indices[k]][feature];
        if (k < MIN_LEAF || value === next || leftWeight <= 0 || leftWeight >= weight) continue;
        const gain = left ** 2 / leftWeight + (total - left) ** 2 / (weight - leftWeight) - total ** 2 / weight;
        if (gain > best.gain) best = { gain, feature, cutoff: (value + next) / 2 };
      }
    }
    if (best.gain === 0) return leaf;
    const { feature, cutoff } = best;
    const left: number[][] = [];
    const right: number[][] = [];
    for (const indices of ordered) {
      left.push([]);
      right.push([]);
      for (const i of indices) (features[i][feature] <= cutoff ? left : right).at(-1)!.push(i);
    }
    return [feature, cutoff, fitNode(left, depth - 1), fitNode(right, depth - 1)];
  }

  const trees: Tree[] = [];
  for (let i = 0; i < TREES; i++) {
    const tree = fitNode(sorted, 2);
    trees.push(tree);
    for (const [j, values] of features.entries()) residuals[j] -= treeValue(tree, values);
  }
  return { intercept: baseline, trees };
}

function ranks(values: number[]): number[] {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const rank = new Array<number>(values.length);
  for (let i = 0; i < order.length;) {
    let end = i + 1;
    while (end < order.length && values[order[end]] === values[order[i]]) end++;
    for (let j = i; j < end; j++) rank[order[j]] = (i + end - 1) / 2;
    i = end;
  }
  return rank;
}

type Prediction = Observation & { score: number };

function spearman(rows: Prediction[]): number {
  const a = ranks(rows.map((row) => row.score));
  const b = ranks(rows.map((row) => row.label));
  const center = (rows.length - 1) / 2;
  const variance = (values: number[]) => mean(values.map((value) => (value - center) ** 2));
  return mean(a.map((value, i) => (value - center) * (b[i] - center))) /
    Math.sqrt(variance(a) * variance(b));
}

function csv(rows: Row[]): string {
  return rows.map(({ quarter, slot, mint, features, label }) =>
    [quarter, slot, mint, ...features, label ?? ''].join(',') + '\n').join('');
}

async function main() {
  const mode = process.argv[2] ?? 'train';
  if (!['train', 'fit', 'append-w4'].includes(mode)) throw new Error('Expected train, fit, or append-w4');
  const manifest = readJson<Manifest>(resolve(data, 'manifest.json'));
  const { hello, guardrails } = config(manifest);
  const indices = mode === 'append-w4' ? [3] : [0, 1, 2];
  const windows = readWindows(data, manifest, 4, new Set(indices));

  const header = ['quarter', 'slot', 'mint', ...FEATURE_NAMES, 'net_pnl_per_sol'].join(',') + '\n';
  const rows: Row[] = [];
  if (mode === 'fit') {
    const lines = readFileSync(output, 'utf8').trimEnd().split('\n');
    if (lines.shift() !== header.trimEnd()) throw new Error('Unexpected event study CSV header');
    for (const line of lines) {
      const [quarter, slot, mint, ...fields] = line.split(',');
      if (quarter === '4') continue;
      const label = fields.pop();
      rows.push({ quarter: Number(quarter), slot: Number(slot), mint, features: fields.map(Number),
        label: label ? Number(label) : null });
    }
  } else {
    for (const i of indices) {
      const quarter = await eventRows(i + 1, windows.get(i)!, hello, guardrails);
      console.error(JSON.stringify({ quarter: i + 1, signals: quarter.length, labeled: quarter.filter((row) => row.label !== null).length }));
      rows.push(...quarter);
    }
    if (mode === 'append-w4') {
      const existing = readFileSync(output, 'utf8');
      if (!existing.startsWith(header) || /^4,/m.test(existing)) throw new Error('Expected a W1–W3-only CSV');
      appendFileSync(output, csv(rows));
      return;
    }
    writeFileSync(output, header + csv(rows));
  }

  const observed = rows.filter((row): row is Observation => row.label !== null);
  const models = indices.map((i) => fitTrees(observed.filter((row) => row.quarter !== i + 1)));
  const predictions = observed.map((row) => ({ ...row, score: predict(models[row.quarter - 1], row.features) }));
  const sorted = [...predictions].sort((a, b) => a.score - b.score);
  const deciles = Array.from({ length: 10 }, (_, i) => {
    const bin = sorted.slice(Math.floor(i * sorted.length / 10), Math.floor((i + 1) * sorted.length / 10));
    return { count: bin.length, score_min: bin[0].score, score_max: bin.at(-1)!.score, mean_label: mean(bin.map((row) => row.label)) };
  });
  console.log(JSON.stringify({
    model: { treeCount: TREES, minLeaf: MIN_LEAF, learningRate: LEARNING_RATE, notionalWeight: 2 },
    spearman: spearman(predictions),
    spearman_by_quarter: indices.map((i) => spearman(predictions.filter((row) => row.quarter === i + 1))),
    deciles,
  }));

  const quantiles = [0.85, 0.9, 0.915, 0.93, 0.945, 0.95, 0.96, 0.975, 0.99, 0.995];
  const trials: { minScore: number; metrics: Metrics[] }[] = [];
  for (const quantile of quantiles) {
    const minScore = sorted[Math.floor(quantile * (sorted.length - 1))].score;
    const metrics: Metrics[] = [];
    for (const i of indices) {
      const { batches, endSlot } = windows.get(i)!;
      metrics.push(await replay(createScoredStrategy(models[i], { minScore }), hello, guardrails, batches, endSlot));
    }
    trials.push({ minScore, metrics });
    console.log(JSON.stringify({ quantile, minScore, metrics }));
  }
  // Favor a common threshold that works across quarters on genuinely held-out scores.
  const eligible = trials.filter(({ metrics }) => metrics.every((m) => m.guardrails_ok));
  const worst = ({ metrics }: typeof trials[number]) => Math.min(...metrics.map((m) => m.net_pnl_sol));
  const winner = eligible.sort((a, b) => worst(b) - worst(a))[0];
  if (!winner) throw new Error('No threshold passed the guardrails across all quarters');
  console.log(JSON.stringify({ minScore: winner.minScore, model: fitTrees(observed) }));
}

await main();
