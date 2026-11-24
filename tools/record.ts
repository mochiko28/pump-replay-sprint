import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { PUMP_PROGRAM_ID, type ChainEvent, type ChainMeta, type TradeEventRecord } from '../vendor/makefun-bot.ts';

const endpoint = 'wss://api.mainnet-beta.solana.com';
const sol = '11111111111111111111111111111111';
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type EventName = ChainEvent['event'];
type Decoded<T = ChainEvent> = T extends ChainEvent ? Omit<T, keyof ChainMeta> : never;
type Captured = { slot: number; signature: string; log_index: number; event: Decoded };
type WireType = 'string' | 'pubkey' | 'i64' | 'u64' | 'bool' | 'u8' | 'shareholders';

// Field order from the kit's pinned pump.fun IDL (639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22).
const layouts = {
  CreateEvent: [
    ['name', 'string'],
    ['symbol', 'string'],
    ['uri', 'string'],
    ['mint', 'pubkey'],
    ['bonding_curve', 'pubkey'],
    ['user', 'pubkey'],
    ['creator', 'pubkey'],
    ['timestamp', 'i64'],
    ['virtual_token_reserves', 'u64'],
    ['virtual_sol_reserves', 'u64'],
    ['real_token_reserves', 'u64'],
    ['token_total_supply', 'u64'],
    ['token_program', 'pubkey'],
    ['is_mayhem_mode', 'bool'],
    ['is_cashback_enabled', 'bool'],
    ['quote_mint', 'pubkey'],
    ['virtual_quote_reserves', 'u64'],
    ['creator_fee_bps', 'u64'],
    ['is_holder_reward', 'bool'],
    ['depth', 'u8'],
  ],
  TradeEvent: [
    ['mint', 'pubkey'],
    ['sol_amount', 'u64'],
    ['token_amount', 'u64'],
    ['is_buy', 'bool'],
    ['user', 'pubkey'],
    ['timestamp', 'i64'],
    ['virtual_sol_reserves', 'u64'],
    ['virtual_token_reserves', 'u64'],
    ['real_sol_reserves', 'u64'],
    ['real_token_reserves', 'u64'],
    ['fee_recipient', 'pubkey'],
    ['fee_basis_points', 'u64'],
    ['fee', 'u64'],
    ['creator', 'pubkey'],
    ['creator_fee_basis_points', 'u64'],
    ['creator_fee', 'u64'],
    ['track_volume', 'bool'],
    ['total_unclaimed_tokens', 'u64'],
    ['total_claimed_tokens', 'u64'],
    ['current_sol_volume', 'u64'],
    ['last_update_timestamp', 'i64'],
    ['ix_name', 'string'],
    ['mayhem_mode', 'bool'],
    ['cashback_fee_basis_points', 'u64'],
    ['cashback', 'u64'],
    ['buyback_fee_basis_points', 'u64'],
    ['buyback_fee', 'u64'],
    ['shareholders', 'shareholders'],
    ['quote_mint', 'pubkey'],
    ['quote_amount', 'u64'],
    ['virtual_quote_reserves', 'u64'],
    ['real_quote_reserves', 'u64'],
    ['holder_rewards_bps', 'u64'],
    ['holder_rewards', 'u64'],
    ['creator_fee_unclaimed', 'u64'],
  ],
  CompleteEvent: [
    ['user', 'pubkey'],
    ['mint', 'pubkey'],
    ['bonding_curve', 'pubkey'],
    ['timestamp', 'i64'],
    ['quote_mint', 'pubkey'],
  ],
} as const satisfies Record<EventName, readonly (readonly [string, WireType])[]>;
const eventNames = Object.keys(layouts) as EventName[];
const discriminators = new Map(eventNames.map(name => [sha256(`event:${name}`).slice(0, 16), name]));
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function base58(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }
  return encoded;
}

function decode(encoded: string): Decoded | undefined {
  const bytes = Buffer.from(encoded, 'base64');
  const event = discriminators.get(bytes.toString('hex', 0, 8));
  if (event === undefined) return;
  let offset = 8;
  function take(size: number): Buffer {
    if (size > bytes.length - offset) throw new Error('Truncated Borsh field');
    const field = bytes.subarray(offset, offset + size);
    offset += size;
    return field;
  }
  function read(type: WireType): unknown {
    switch (type) {
      case 'u64': return take(8).readBigUInt64LE().toString();
      case 'i64': return take(8).readBigInt64LE().toString();
      case 'u8': return take(1)[0];
      case 'pubkey': return base58(take(32));
      case 'string': return utf8.decode(take(take(4).readUInt32LE()));
      case 'bool': {
        const value = take(1)[0];
        if (value > 1) throw new Error('Invalid Borsh boolean');
        return value === 1;
      }
      case 'shareholders': {
        const count = take(4).readUInt32LE();
        if (count > Math.floor((bytes.length - offset) / 34)) throw new Error('Truncated shareholders');
        return Array.from({ length: count }, () => ({
          address: base58(take(32)), share_bps: take(2).readUInt16LE(),
        }));
      }
    }
  }

  const fields: Record<string, unknown> = { event };
  for (const [name, type] of layouts[event]) {
    try {
      fields[name] = read(type);
    } catch (error) {
      throw new Error(`${event}.${name}: ${(error as Error).message}`);
    }
  }
  // The kit layout permits additional fields appended by newer program versions.
  return fields as Decoded;
}

// The buy leg of multi_hop_swap spends an exact quote amount. Its sell leg uses the sell formula.
const exactInInstructions = new Set(['buy_exact_sol_in', 'buy_exact_quote_in', 'multi_hop_swap']);

type Reserves = readonly [bigint, bigint, bigint, bigint];

function reserves(event: Decoded<TradeEventRecord>): { pre: Reserves; post: Reserves; priceOk: boolean; monotone: boolean } {
  const q = BigInt(event.quote_amount);
  const t = BigInt(event.token_amount);
  const vq = BigInt(event.virtual_quote_reserves);
  const vt = BigInt(event.virtual_token_reserves);
  const rq = BigInt(event.real_quote_reserves);
  const rt = BigInt(event.real_token_reserves);
  const sign = event.is_buy ? 1n : -1n;
  const pre: Reserves = [vq - sign * q, vt + sign * t, rq - sign * q, rt + sign * t];
  const [pq, pt, prq, prt] = pre;
  // A dust sell can legitimately round down to zero lamports.
  const monotone = (event.is_buy ? q > 0n : q >= 0n) && t > 0n && pq > 0n && pt > 0n &&
    prq >= 0n && prt >= 0n && vq > 0n && vt > 0n;
  const solMatches = (legacy: string, quote: string) => legacy === (event.quote_mint === sol ? quote : '0');
  let priceOk = monotone && solMatches(event.sol_amount, event.quote_amount) &&
    solMatches(event.virtual_sol_reserves, event.virtual_quote_reserves) &&
    solMatches(event.real_sol_reserves, event.real_quote_reserves);
  if (priceOk) {
    if (!event.is_buy) priceOk = q === t * pq / (pt + t);
    else if (rt !== 0n && exactInInstructions.has(event.ix_name)) {
      priceOk = t === (q - 1n) * pt / (pq + q - 1n);
    } else priceOk = q === t * pq / vt + 1n;
  }
  return { pre, post: [vq, vt, rq, rt], priceOk, monotone };
}

function usesKitCurve(event: Decoded<TradeEventRecord>): boolean {
  return event.quote_mint === sol && !event.mayhem_mode &&
    event.cashback_fee_basis_points === '0' && event.cashback === '0';
}

function counters() {
  return {
    notifications: 0, failed: 0, log_truncations: 0, decode_errors: 0, disconnects: 0, subscriptions: 0,
    CreateEvent: 0, TradeEvent: 0, CompleteEvent: 0, reserve_direction_errors: 0, price_checks: 0, price_errors: 0,
  };
}

type Counters = ReturnType<typeof counters>;
type LogsMessage = {
  id?: number;
  result?: number;
  error?: { code: number; message: string };
  method?: string;
  params?: { subscription: number; result: {
    context: { slot: number };
    value: { signature: string; err: unknown; logs: string[] | null };
  } };
};

function captureLogs(message: LogsMessage, counts: Counters): Captured[] {
  if (message.method !== 'logsNotification' || !message.params) return [];
  const { context: { slot }, value: { signature, err, logs } } = message.params.result;
  counts.notifications++;
  if (err !== null) {
    counts.failed++;
    return [];
  }

  const stack: { program: string; firstEvent: number }[] = [];
  const events: Captured[] = [];
  for (const [log_index, line] of (logs ?? []).entries()) {
    // Mentions alone do not establish which program emitted a payload.
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      const depth = Number(invoke[2]);
      stack.length = depth - 1;
      stack.push({ program: invoke[1], firstEvent: events.length });
      continue;
    }
    const exit = /^Program (\w+) (success|failed:.*)$/.exec(line);
    if (exit && stack.at(-1)?.program === exit[1]) {
      const frame = stack.pop()!;
      if (exit[2] !== 'success') events.length = frame.firstEvent;
      continue;
    }
    if (line === 'Log truncated') counts.log_truncations++;
    if (!line.startsWith('Program data: ') || stack.at(-1)?.program !== PUMP_PROGRAM_ID) continue;
    try {
      const event = decode(line.slice('Program data: '.length));
      if (event) events.push({ slot, signature, log_index, event });
    } catch (error) {
      if (counts.decode_errors++ === 0) console.error((error as Error).message);
    }
  }
  return events;
}

async function record(out: string, duration: number) {
  const started = new Date();
  const session = started.toISOString().replaceAll(':', '') + '-' + process.pid;
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const deadline = setTimeout(abort, duration);
  const total = counters();
  let interval = counters();
  let lastReport = started.getTime();
  function report(final = false) {
    const now = Date.now();
    const events = interval.CreateEvent + interval.TradeEvent + interval.CompleteEvent;
    for (const key of Object.keys(interval) as (keyof Counters)[]) total[key] += interval[key];
    console.error(JSON.stringify({
      time: new Date(now).toISOString(), session, ...interval,
      events_per_minute: Math.round(events * 60_000 / Math.max(1, now - lastReport)),
      ...(final ? { total } : {}),
    }));
    lastReport = now;
    interval = counters();
  }
  const ticker = setInterval(() => report(), 60_000);
  console.error(`Recording session ${session} from ${endpoint} into ${out}`);
  const files = new Set<string>();
  let retry = 1_000;

  try {
    while (!stop.signal.aborted) {
      const ws = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => {
        let subscription: number | undefined;
        let lastMessage = Date.now();
        let finished = false;
        const finish = (reason?: string, error?: unknown) => {
          if (finished) return;
          finished = true;
          clearInterval(watchdog);
          stop.signal.removeEventListener('abort', onAbort);
          if (ws.readyState < WebSocket.CLOSING) ws.close();
          if (reason) {
            interval.disconnects++;
            console.error(`WebSocket ${reason}`);
          }
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish();
        const watchdog = setInterval(() => {
          if (Date.now() - lastMessage > 20_000) finish('timed out');
        }, 5_000);
        stop.signal.addEventListener('abort', onAbort, { once: true });
        ws.addEventListener('open', () => {
          if (finished) return;
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
            params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'confirmed' }],
          }));
        });
        ws.addEventListener('error', event => {
          const message = 'message' in event && typeof event.message === 'string' ? event.message : '';
          finish(message ? `error (${message})` : 'error');
        });
        ws.addEventListener('close', event => finish(`closed (${event.code})`));
        ws.addEventListener('message', ({ data }) => {
          if (finished) return;
          lastMessage = Date.now();
          try {
            const message = JSON.parse(data as string) as LogsMessage;
            if (message.id === 1) {
              if (message.error) return finish(`subscription failed (${message.error.code})`);
              if (typeof message.result !== 'number') return finish('returned an invalid subscription ID');
              subscription = message.result;
              interval.subscriptions++;
              retry = 1_000;
            }
            if (subscription === undefined || message.params?.subscription !== subscription) return;
            const rows = captureLogs(message, interval);
            if (rows.length) {
              const now = new Date().toISOString();
              const path = join(out, now.slice(0, 10), `${now.slice(11, 13)}-${session}.ndjson`);
              if (!files.has(path)) mkdirSync(dirname(path), { recursive: true });
              appendFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join(''));
              files.add(path);
              for (const { event } of rows) {
                interval[event.event]++;
                if (event.event === 'TradeEvent') {
                  const { monotone, priceOk } = reserves(event);
                  if (!monotone) interval.reserve_direction_errors++;
                  if (usesKitCurve(event)) {
                    interval.price_checks++;
                    if (!priceOk) interval.price_errors++;
                  }
                }
              }
            }
          } catch (error) {
            finish(undefined, error);
          }
        });
      });
      if (!stop.signal.aborted) {
        await delay(retry, undefined, { signal: stop.signal }).catch(error => {
          if (!stop.signal.aborted) throw error;
        });
        retry = Math.min(retry * 2, 30_000);
      }
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(ticker);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    report(true);
    for (const file of files) console.log(file);
  }

  if (!files.size) throw new Error('No pump.fun events were recorded.');
}

// Same sampling and exclusions as the kit. The raw capture retains every decoded event.
const universe = {
  program: PUMP_PROGRAM_ID, quote: 'SOL', mayhem: 'excluded', exclude_cashback: true,
  sample: { hash: 'sha256', modulus: 16, residue: 15 },
} as const;

function sampled(mint: string): boolean {
  // Hash the UTF-8 base58 text and read the full digest as an unsigned big-endian integer.
  return BigInt(`0x${sha256(mint)}`) % BigInt(universe.sample.modulus) === BigInt(universe.sample.residue);
}

type Trade = Captured & { event: Decoded<TradeEventRecord> };
function isTrade(row: Captured): row is Trade {
  return row.event.event === 'TradeEvent';
}

function eventTime(event: Decoded): number | null {
  const seconds = Number(event.timestamp);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000_000 ? seconds : null;
}

function orderMint(rows: Captured[]) {
  const events: ChainEvent[] = [];
  let last: Reserves | undefined;
  let complete = false;
  let issue: string | undefined;
  let inSlotOrder = false;
  let priceChecks = 0;
  let priceErrors = 0;
  const quoteMint = rows[0].event.quote_mint;

  function add({ event, slot, signature }: Captured) {
    events.push({ ...event, slot, signature, block_time: eventTime(event), chain_seq: events.length });
    if (event.quote_mint !== quoteMint) issue ??= `Quote mint changed at slot ${slot}`;
  }

  for (let start = 0; start < rows.length;) {
    const slot = rows[start].slot;
    let end = start + 1;
    while (rows[end]?.slot === slot) end++;
    const group = rows.slice(start, end);
    if (complete) issue ??= `Events after completion at slot ${slot}`;
    for (const row of group) {
      const event = row.event;
      if (event.event !== 'CreateEvent') continue;
      if (events.length) issue ??= `Duplicate creation at slot ${slot}`;
      last = [BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves),
        0n, BigInt(event.real_token_reserves)];
      if (event.virtual_sol_reserves !== event.virtual_quote_reserves || last[0] <= 0n || last[1] <= 0n) {
        issue ??= `Invalid create reserves at slot ${slot}`;
      }
      add(row);
    }

    // Log order is known inside a transaction. Across transactions in a slot, link the
    // recorded post-trade reserves to the next trade's implied pre-trade reserves.
    const byTransaction = new Map<string, Trade[]>();
    for (const row of group.filter(isTrade)) {
      const tx = byTransaction.get(row.signature);
      if (tx) tx.push(row);
      else byTransaction.set(row.signature, [row]);
    }
    const trades = [...byTransaction.values()].map(tx =>
      tx.sort((a, b) => a.log_index - b.log_index).map(row => ({ row, ...reserves(row.event) })),
    );
    while (trades.length) {
      const previous = last;
      const next = previous ? trades.findIndex(tx => tx[0].pre.every((value, i) => value === previous[i])) : -1;
      if (next > 0) inSlotOrder = true;
      const [tx] = trades.splice(Math.max(next, 0), 1);
      for (const trade of tx) {
        if (!last || !last.every((value, i) => value === trade.pre[i])) issue ??= `Reserve discontinuity at slot ${slot}`;
        priceChecks++;
        if (!trade.priceOk) {
          priceErrors++;
          issue ??= `Invalid trade price or reserves at slot ${slot}`;
        }
        last = trade.post;
        add(trade.row);
      }
    }
    for (const row of group) {
      if (row.event.event !== 'CompleteEvent') continue;
      if (complete || last?.[3] !== 0n) issue ??= `Unexpected completion at slot ${slot}`;
      complete = true;
      add(row);
    }
    start = end;
  }
  return { events, issue, inSlotOrder, priceChecks, priceErrors };
}

function compareEvents(a: ChainEvent, b: ChainEvent): number {
  return a.slot - b.slot || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : a.chain_seq - b.chain_seq);
}

async function convert(out: string, paths: string[]) {
  if (existsSync(out)) throw new Error(`Dataset output already exists: ${out}`);
  const mints = new Map<string, Captured[]>();
  const seen = new Set<string>();
  const observed = { CreateEvent: 0, TradeEvent: 0, CompleteEvent: 0, duplicates: 0 };
  let startSlot = Infinity;
  let endSlot = -Infinity;
  let firstTime = Infinity;
  let lastTime = -Infinity;

  for (const path of paths) {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber++;
      let row: Captured;
      try {
        row = JSON.parse(line) as Captured;
        if (!Number.isSafeInteger(row.slot) || !Number.isSafeInteger(row.log_index) ||
            typeof row.signature !== 'string' || typeof row.event.mint !== 'string' ||
            !eventNames.includes(row.event.event)) throw new Error('invalid capture record');
      } catch (error) {
        throw new Error(`${path}:${lineNumber}: ${(error as Error).message}`);
      }
      observed[row.event.event]++;
      startSlot = Math.min(startSlot, row.slot);
      endSlot = Math.max(endSlot, row.slot);
      const time = eventTime(row.event);
      if (time !== null) {
        firstTime = Math.min(firstTime, time);
        lastTime = Math.max(lastTime, time);
      }
      let rows = mints.get(row.event.mint);
      if (!rows) {
        if (!sampled(row.event.mint)) continue;
        rows = [];
        mints.set(row.event.mint, rows);
      }
      const key = `${row.slot}/${row.signature}/${row.log_index}`;
      if (seen.has(key)) {
        observed.duplicates++;
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  }
  if (!Number.isFinite(firstTime)) throw new Error('Capture contains no events with usable timestamps');
  seen.clear();

  const events: ChainEvent[] = [];
  const ruleExcluded = { non_sol_quote: 0, mayhem: 0, cashback: 0 };
  const excluded: { mint: string; reason: string }[] = [];
  let orphans = 0;
  let reordered = 0;
  let countMints = 0;
  let priceChecks = 0;
  let priceErrors = 0;
  // Prefer the order supplied by the RPC as the initial candidate for same-slot records.
  for (const [mint, rows] of mints) {
    mints.delete(mint);
    rows.sort((a, b) => a.slot - b.slot);
    const create = rows.find(row => row.event.event === 'CreateEvent')?.event;
    if (!create || create.event !== 'CreateEvent') {
      orphans++;
      continue;
    }
    if (create.quote_mint !== sol) ruleExcluded.non_sol_quote++;
    else if (create.is_mayhem_mode) ruleExcluded.mayhem++;
    else if (create.is_cashback_enabled) ruleExcluded.cashback++;
    else {
      const chain = orderMint(rows);
      priceChecks += chain.priceChecks;
      priceErrors += chain.priceErrors;
      if (chain.issue) {
        excluded.push({ mint, reason: chain.issue });
      } else {
        if (chain.inSlotOrder) reordered++;
        countMints++;
        for (const event of chain.events) events.push(event);
      }
    }
  }
  events.sort(compareEvents);
  excluded.sort((a, b) => a.mint < b.mint ? -1 : 1);

  const counts = { events: events.length, trades: 0, creates: 0, completes: 0, mints: countMints, events_without_block_time: 0 };
  for (const event of events) {
    if (event.event === 'CreateEvent') counts.creates++;
    else if (event.event === 'TradeEvent') counts.trades++;
    else counts.completes++;
    if (event.block_time === null) counts.events_without_block_time++;
  }

  mkdirSync(dirname(out), { recursive: true });
  const staging = mkdtempSync(join(dirname(out), '.record-'));
  try {
    mkdirSync(join(staging, 'events'));
    const digest = createHash('sha256');
    const files = [];
    for (let start = 0; start < events.length;) {
      let end = Math.min(start + 50_000, events.length);
      while (end < events.length && events[end - 1].slot === events[end].slot) end++;
      const ndjson = events.slice(start, end).map(event => JSON.stringify(event) + '\n').join('');
      const gzip = gzipSync(ndjson);
      const path = `events/part-${String(files.length).padStart(5, '0')}.ndjson.gz`;
      writeFileSync(join(staging, path), gzip);
      files.push({
        path, sha256: sha256(gzip), bytes: gzip.length, ndjson_sha256: sha256(ndjson),
        events: end - start, first_slot: events[start].slot, last_slot: events[end - 1].slot,
      });
      digest.update(ndjson);
      start = end;
    }
    const checked = countMints + excluded.length;
    const unrepairedShare = checked ? excluded.length / checked : 0;
    const accepted = countMints > 0 && unrepairedShare <= 0.02;
    const manifest = {
      schema: 'agent-fun/dataset/v1',
      id: basename(out),
      status: accepted ? 'accepted' : 'rejected',
      created_at: new Date().toISOString(),
      collector: { version: 'entry-record/1', git_sha: null, node: process.version },
      endpoint: { rpc: 'https://api.mainnet-beta.solana.com', ws: endpoint },
      program: PUMP_PROGRAM_ID,
      idl: { commit: '639b87fb45c3adeffa6f7c4a1bf0cb85e392bf22',
        sha256: '7616681ea557975f9f623ac211080f22a93060781eaf4765b0a488d980997207' },
      window: {
        requested_hours: null, start_slot: startSlot, end_slot: endSlot,
        started_at: new Date(firstTime * 1000).toISOString(), ended_at: new Date(lastTime * 1000).toISOString(),
        first_block_time: firstTime, last_block_time: lastTime,
      },
      universe,
      universe_exclusions: ['non_sol_quote', 'mayhem', 'cashback'],
      latency_slots: 2,
      fees: null,
      stream: null,
      counts,
      chain_report: {
        universe_tokens: checked, ok: countMints - reordered, repaired: reordered,
        unrepaired: excluded.length, unrepaired_share: unrepairedShare.toFixed(9),
        max_unrepaired_share: '0.020000000', accepted,
        breaks: { in_slot_order: reordered, missing_event_line: null, real_gap: null, unrepaired: excluded.length },
        stream: null, rpc: null,
        orphans: { checked: orphans, pre_window: null, recovered: 0, unresolved: orphans },
        tail: null, data_errors: null,
      },
      excluded_mints: excluded,
      rule_excluded: ruleExcluded,
      files,
      dataset_sha256: digest.digest('hex'),
      fatal: null,
    };

    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    renameSync(staging, out);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  console.error(JSON.stringify({
    observed, dataset: counts, orphans, rule_excluded: ruleExcluded, excluded: excluded.length, reordered,
    price_checks: priceChecks, price_errors: priceErrors, block_time_source: 'event.timestamp',
  }));
  console.log(out);
}

const usage = `Usage:
  node tools/record.ts [--hours N | --minutes N] [--out /work/.tmp/live]
  node tools/record.ts convert --out DATASET RAW.ndjson [...]`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      hours: { type: 'string' }, minutes: { type: 'string' },
      out: { type: 'string' }, help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals[0] === 'convert') {
    if (!values.out || positionals.length < 2 || values.hours !== undefined || values.minutes !== undefined) {
      throw new Error(usage);
    }
    await convert(resolve(values.out), positionals.slice(1));
    return;
  }
  if (positionals.length || (values.hours !== undefined && values.minutes !== undefined)) throw new Error(usage);
  const duration = values.minutes === undefined ? Number(values.hours ?? 1) * 3_600_000 : Number(values.minutes) * 60_000;
  if (!Number.isFinite(duration) || duration < 1 || duration > 2_147_483_647) throw new Error('Invalid recording duration');
  await record(values.out ?? '/work/.tmp/live', duration);
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
