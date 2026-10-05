#!/usr/bin/env bun
/**
 * ISSUE-237 proof, run by hand: a throwaway Redis, never the shared stack,
 * so 100,000 foreign keys and a SIGKILLed run cannot disturb anyone's slot.
 *
 *   docker run -d --rm -p 127.0.0.1:6390:6379 redis:8.6.1-alpine \
 *     redis-server --databases 512 --save '' --appendonly no
 *   PROOF_REDIS_URL=redis://127.0.0.1:6390 bun proof:test-redis
 *   docker stop <container id>          # when done
 *
 *   1. Cost independent of other slots: teardown (`deleteNamespace` of a
 *      12,000-key namespace) and the namespaces SCAN test are timed over 10
 *      runs with no foreign keys (baseline), then with 100,000 foreign keys in
 *      another slot's logical database (the design), then with the same keys
 *      in the runner's own database (negative control: the old shared db).
 *   2. A killed run leaves nothing that survives the next sweep: a child
 *      writes through the real adapter and is SIGKILLed mid-run; its keys
 *      carry an expiry within the ceiling, and the sweep removes them. Two
 *      negative controls: the sweep keeps a namespace that is not idle, and
 *      an unbounded writer leaves immortal keys that the post-run scan finds.
 */
import { RedisClient } from 'bun';
import { createRedis } from '@offense-demo/redis';
import {
  deleteNamespace,
  listNamespaces,
  sweepIdleNamespaces,
} from '@offense-demo/redis/namespaces';
import { deleteAllKeysWithoutExpiry } from './redis-whole-database';
import {
  createBoundedTestClient,
  TEST_KEY_TTL_MAX_MS,
  TEST_NAMESPACE_PREFIX,
  TEST_RUN_MAX_MS,
  testNamespace,
} from '@offense-demo/redis/testing';
import { proofSteps } from './proof-support';

const FOREIGN_KEYS = 100_000;
const RUNS = 10;
const RUN_KEYS = 12_000;
const KILLED_RUN_KEYS = 2_000;

/** Twelve hex characters from the OS CSPRNG, for a namespace id. */
const createId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function timed<T>(work: () => Promise<T>): Promise<[number, T]> {
  const start = performance.now();
  const result = await work();
  return [performance.now() - start, result];
}

async function child(url: string, mode: string) {
  const namespace = testNamespace(createId());
  if (mode === 'unbounded') {
    const raw = new RedisClient(url);
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        raw.send('SET', [`${namespace}:v1:immortal${index}`, '1']),
      ),
    );
  } else {
    const redis = createRedis({
      url,
      namespace,
      client: createBoundedTestClient(url),
    });
    await Promise.all(
      Array.from({ length: KILLED_RUN_KEYS }, (_, index) =>
        redis.consumeRateLimit(`k${index}`, { windowSeconds: 60, max: 5 }),
      ),
    );
    // A forgetful write: the bounded client must still give it an expiry.
    await redis.setEphemeral('forgot', 'x', 60);
  }
  process.stdout.write(`READY ${namespace}\n`);
  await new Promise(() => {});
}

/**
 * The throwaway server the proof runs against: `PROOF_REDIS_URL`, started by
 * hand with `--databases 512` (the command is in the header). It refuses the
 * shared stack's port and any server whose databases 3, 4 or 6 hold keys,
 * because the proof fills them.
 */
async function requireThrowawayRedis(): Promise<string> {
  const base = process.env.PROOF_REDIS_URL?.replace(/\/$/, '');
  if (!base)
    throw new Error(
      "Set PROOF_REDIS_URL to a throwaway Redis (see the command in this file's header)",
    );
  const parsed = new URL(base);
  if (
    parsed.port === '' ||
    parsed.port === '6379' ||
    !['', '/'].includes(parsed.pathname)
  )
    throw new Error(
      'PROOF_REDIS_URL must be a throwaway server on its own port (an explicit port, not the shared stack on 6379) and name no database',
    );
  for (const database of [3, 4, 6]) {
    const client = new RedisClient(`${base}/${database}`);
    try {
      if (Number(await client.send('DBSIZE', [])) > 0)
        throw new Error(`database ${database} of ${base} is not empty`);
    } finally {
      client.close();
    }
  }
  return base;
}

/** One suite's teardown and SCAN test against `url`'s database. */
async function oneRun(url: string) {
  const client = new RedisClient(url);
  const namespace = testNamespace(createId());
  try {
    await Promise.all(
      Array.from({ length: RUN_KEYS }, (_, index) =>
        client.send('SET', [`${namespace}:v1:k${index}`, '1', 'EX', '600']),
      ),
    );
    const [scanMs, found] = await timed(() =>
      listNamespaces(client, namespace),
    );
    const [teardownMs, removed] = await timed(() =>
      deleteNamespace(client, namespace),
    );
    if (found.length !== 1 || removed !== RUN_KEYS)
      throw new Error(`run saw ${found.length} namespaces, removed ${removed}`);
    return { scanMs, teardownMs };
  } finally {
    client.close();
  }
}

async function measure(label: string, url: string) {
  const runs = [];
  for (let run = 0; run < RUNS; run += 1) runs.push(await oneRun(url));
  const scan = median(runs.map(({ scanMs }) => scanMs));
  const teardown = median(runs.map(({ teardownMs }) => teardownMs));
  const worst = Math.max(...runs.map(({ teardownMs }) => teardownMs));
  process.stdout.write(
    `${label.padEnd(34)} SCAN median ${scan.toFixed(1)} ms   teardown median ${teardown.toFixed(1)} ms (worst ${worst.toFixed(1)} ms) over ${RUNS} runs\n`,
  );
  return { scan, teardown };
}

const { check, finish } = proofSteps();

async function preloadForeign(admin: RedisClient) {
  await admin.send('EVAL', [
    `for i = 1, tonumber(ARGV[1]) do
       redis.call('SET', ARGV[2] .. (i % 85) .. ':v1:k' .. i, '1', 'EX', 7200)
     end
     return 1`,
    '0',
    String(FOREIGN_KEYS),
    `${TEST_NAMESPACE_PREFIX}foreign`,
  ]);
}

async function proveCost(base: string) {
  const own = `${base}/4`;
  const foreignSlot = `${base}/3`;
  const baseline = await measure('baseline (no foreign keys)', own);

  const admin = new RedisClient(foreignSlot);
  await preloadForeign(admin);
  const held = Number(await admin.send('DBSIZE', []));
  process.stdout.write(
    `preloaded ${held} foreign keys in another slot's database (3)\n`,
  );
  const isolated = await measure('own database, 100k foreign keys', own);
  check(
    isolated.scan <= Math.max(baseline.scan * 2, baseline.scan + 25) &&
      isolated.teardown <=
        Math.max(baseline.teardown * 2, baseline.teardown + 25),
    'AC3: SCAN test and teardown do not grow with another slot’s 100k keys',
  );

  const shared = await measure(
    'shared database, 100k foreign keys',
    foreignSlot,
  );
  check(
    shared.scan >= baseline.scan * 3 &&
      shared.teardown >= baseline.teardown * 3,
    'AC3 negative control: the same keys in the runner’s own database DO slow both (measurement is sensitive)',
  );
  await admin.send('EVAL', [
    `local n = 0
     local cursor = '0'
     repeat
       local r = redis.call('SCAN', cursor, 'MATCH', ARGV[1] .. '*', 'COUNT', 5000)
       cursor = r[1]
       if #r[2] > 0 then redis.call('UNLINK', unpack(r[2])) n = n + #r[2] end
     until cursor == '0'
     return n`,
    '0',
    `${TEST_NAMESPACE_PREFIX}foreign`,
  ]);
  admin.close();
}

async function killedRun(base: string, mode: string) {
  const url = `${base}/6`;
  const proc = Bun.spawn(['bun', import.meta.path, '--child', url, mode], {
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
  });
  const reader = proc.stdout.getReader();
  let seen = '';
  while (!seen.includes('READY')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('child exited before it was ready');
    seen += new TextDecoder().decode(value);
  }
  proc.kill('SIGKILL');
  await proc.exited;
  return {
    url,
    killedBy: proc.signalCode,
    namespace: /READY (\S+)/.exec(seen)?.[1] ?? '',
  };
}

async function proveKilledRun(base: string) {
  const { url, killedBy, namespace } = await killedRun(base, 'bounded');
  const db = new RedisClient(url);
  const keys = (await db.send('KEYS', [`${namespace}:*`])) as string[];
  const ttls = await Promise.all(keys.map((key) => db.send('PTTL', [key])));
  check(
    killedBy === 'SIGKILL' && keys.length > KILLED_RUN_KEYS,
    `AC4: a run SIGKILLed mid-way left ${keys.length} keys behind (the leak the sweep must clear)`,
  );
  check(
    ttls.every((ttl) => Number(ttl) > 0 && Number(ttl) <= TEST_KEY_TTL_MAX_MS),
    'AC1: every key the killed run left carries an expiry within the ceiling',
  );
  const keptByRealLimit = await sweepIdleNamespaces(db, {
    prefix: TEST_NAMESPACE_PREFIX,
    idleMs: TEST_RUN_MAX_MS,
  });
  check(
    keptByRealLimit.keys === 0,
    'AC2 negative control: the real one-hour limit keeps a run that has not been idle that long',
  );
  await Bun.sleep(2_100);
  const swept = await sweepIdleNamespaces(db, {
    prefix: TEST_NAMESPACE_PREFIX,
    idleMs: 1_500,
  });
  const left = (await db.send('KEYS', [`${namespace}:*`])) as string[];
  check(
    swept.namespaces.includes(namespace) && left.length === 0,
    'AC2: the next run’s sweep removes everything the killed run left',
  );

  const control = await killedRun(base, 'unbounded');
  const immortal = await deleteAllKeysWithoutExpiry(db);
  check(
    immortal.length === 500 &&
      immortal.every((key) => key.startsWith(`${control.namespace}:`)),
    'AC1 negative control: an unbounded writer leaves immortal keys, found and removed by the post-run scan',
  );
  db.close();
}

async function main() {
  const base = await requireThrowawayRedis();
  await proveCost(base);
  await proveKilledRun(base);
  finish();
}

const [, , flag, url, mode] = process.argv;
if (flag === '--child' && url && mode) await child(url, mode);
else await main();
