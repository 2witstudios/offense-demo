import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createRedis } from '../src';
import {
  deleteKeysWithoutExpiry,
  deleteNamespace,
  sweepIdleNamespaces,
} from '../src/namespaces';
import {
  createBoundedTestClient,
  openTestRedis,
  testNamespace,
  TEST_KEY_TTL_MAX_MS,
  type TestRedis,
} from '../src/testing';

setupRitewayBun();

const { redisUrl: url } = requireTestServices(process.env);

/** Runs `work` with a raw client, a bounded one and this test's own key prefix, then removes its keys. */
async function withClients<T>(
  work: (context: {
    readonly raw: TestRedis;
    readonly bounded: TestRedis;
    readonly namespace: string;
  }) => Promise<T>,
): Promise<T> {
  const raw = openTestRedis(url);
  const bounded = createBoundedTestClient(url);
  const namespace = testNamespace(createId());
  try {
    return await work({ raw, bounded, namespace });
  } finally {
    await deleteNamespace(raw, namespace);
    raw.close();
    bounded.close();
  }
}

const pttlOf = async (raw: TestRedis, key: string) =>
  Number(await raw.send('PTTL', [key]));

/** Waits until Redis reports the key idle for at least one second. */
async function untilIdle(raw: TestRedis, key: string) {
  const deadline = Date.now() + 5_000;
  while (Number(await raw.send('OBJECT', ['IDLETIME', key])) < 1) {
    if (Date.now() > deadline) throw new Error(`${key} never became idle`);
    await Bun.sleep(50);
  }
}

test('ISSUE-237-AC1: no write through the bounded client can be immortal or outlive the ceiling', () =>
  withClients(async ({ raw, bounded, namespace }) => {
    const key = (name: string) => `${namespace}:v1:${name}`;
    // The adapter's options queue nothing while offline, so connect first.
    await bounded.connect();
    await bounded.send('SET', [key('bare'), 'v']);
    await bounded.send('SET', [key('long'), 'v', 'EX', '99999999']);
    await bounded.send('INCR', [key('counter')]);
    await bounded.send('ZADD', [key('zset'), '1', 'member']);
    // A registered adapter script (the rate limiter) arming a window far past the ceiling.
    await createRedis({ url, namespace, client: bounded }).consumeRateLimit(
      'scripted',
      { windowSeconds: 99_999, max: 5 },
    );
    await bounded.send('SET', [key('short'), 'v', 'EX', '60']);

    const ttls = Object.fromEntries(
      await Promise.all(
        ['bare', 'long', 'counter', 'zset', 'rl:scripted', 'short'].map(
          async (name) => [name, await pttlOf(raw, key(name))] as const,
        ),
      ),
    );

    assert({
      given:
        'a bare SET, a SET beyond the ceiling, INCR, ZADD and a script write',
      should:
        'leave each with a TTL in (0, ceiling], and the 60 s key with its own shorter one',
      actual: {
        bounded: Object.entries(ttls)
          .filter(([name]) => name !== 'short')
          .every(([, ttl]) => ttl > 0 && ttl <= TEST_KEY_TTL_MAX_MS),
        short: ttls.short !== undefined && ttls.short <= 60_000,
      },
      expected: { bounded: true, short: true },
    });
  }));

test('ISSUE-237-AC1 negative control: the same writes through an unbounded client ARE immortal', () =>
  withClients(async ({ raw, namespace }) => {
    const key = `${namespace}:v1:bare`;
    await raw.send('SET', [key, 'v']);

    assert({
      given: 'a bare SET through a plain client',
      should: 'leave PTTL -1, which is what the wrapper prevents',
      actual: await pttlOf(raw, key),
      expected: -1,
    });
  }));

test('ISSUE-237-AC2: the sweep removes an idle namespace and spares a fresh one', () =>
  withClients(async ({ raw, namespace }) => {
    const stale = `${namespace}-old`;
    const fresh = `${namespace}-new`;
    await raw.send('SET', [`${stale}:v1:a`, '1', 'EX', '600']);
    await raw.send('SET', [`${stale}:v1:b`, '1', 'EX', '600']);
    await untilIdle(raw, `${stale}:v1:a`);
    await untilIdle(raw, `${stale}:v1:b`);
    await raw.send('SET', [`${fresh}:v1:a`, '1', 'EX', '600']);

    const swept = await sweepIdleNamespaces(raw, {
      prefix: `${namespace}-`,
      idleMs: 500,
    });

    assert({
      given:
        'a namespace idle over a second and one written just now, swept with a 500 ms limit',
      should: 'delete the idle one only',
      actual: {
        swept,
        staleLeft: await raw.exists(`${stale}:v1:a`),
        freshLeft: await raw.exists(`${fresh}:v1:a`),
      },
      expected: {
        swept: { namespaces: [stale], keys: 2 },
        staleLeft: false,
        freshLeft: true,
      },
    });
  }));

test('ISSUE-237-AC2 negative control: with the limit above its idle time, nothing is swept', () =>
  withClients(async ({ raw, namespace }) => {
    const key = `${namespace}-old:v1:a`;
    await raw.send('SET', [key, '1', 'EX', '600']);
    await untilIdle(raw, key);

    const swept = await sweepIdleNamespaces(raw, {
      prefix: `${namespace}-`,
      idleMs: 3_600_000,
    });

    assert({
      given: 'the same idle namespace and a one-hour limit',
      should: 'keep it, so only idleness (not existence) selects a namespace',
      actual: { swept, kept: await raw.exists(key) },
      expected: { swept: { namespaces: [], keys: 0 }, kept: true },
    });
  }));

test('ISSUE-237-AC1: the post-run scan finds and removes a key with no expiry, and only that', () =>
  withClients(async ({ raw, namespace }) => {
    const forever = `${namespace}:v1:forever`;
    const soon = `${namespace}:v1:soon`;
    await raw.send('SET', [forever, '1']);
    await raw.send('SET', [soon, '1', 'EX', '600']);

    const removed = await deleteKeysWithoutExpiry(raw, `${namespace}:*`);

    assert({
      given: 'one immortal key and one expiring key in the test database',
      should: 'report and remove the immortal key and keep the other',
      actual: {
        reported: removed.includes(forever) && !removed.includes(soon),
        foreverLeft: await raw.exists(forever),
        soonLeft: await raw.exists(soon),
      },
      expected: { reported: true, foreverLeft: false, soonLeft: true },
    });
  }));
