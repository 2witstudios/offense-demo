import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { deleteKeysWithoutExpiry, sweepIdleNamespaces } from './namespaces';

setupRitewayBun();

/**
 * An in-memory stand-in for the Redis commands the sweep issues, so the
 * selection rule is proven without a server: SCAN (paged), OBJECT IDLETIME
 * (seconds), PTTL and UNLINK.
 */
function fakeKeyspace(
  entries: Readonly<Record<string, { idleSeconds: number; pttl?: number }>>,
  pageSize = 2,
) {
  const keys = new Map(Object.entries(entries));
  const commands: string[] = [];
  const scan = (args: string[]) => {
    const start = Number(args[0]);
    const prefix = (args[args.indexOf('MATCH') + 1] ?? '*').replace(/\*$/, '');
    const page = [...keys.keys()].slice(start, start + pageSize);
    const done = start + pageSize >= keys.size;
    return [
      done ? '0' : String(start + pageSize),
      page.filter((key) => key.startsWith(prefix)),
    ];
  };
  const unlink = (args: string[]) =>
    args.filter((key) => keys.delete(key)).length;
  const handlers: Record<string, (args: string[]) => unknown> = {
    SCAN: scan,
    OBJECT: ([, key]) => keys.get(key ?? '')?.idleSeconds ?? null,
    PTTL: ([key]) => keys.get(key ?? '')?.pttl ?? 1000,
    UNLINK: unlink,
  };
  return {
    keys: () => [...keys.keys()].sort(),
    commands,
    async send(command: string, args: string[]): Promise<unknown> {
      commands.push(command);
      const handler = handlers[command];
      if (!handler) throw new Error(`fake keyspace: unexpected ${command}`);
      return handler(args);
    },
  };
}

const HOUR_MS = 3_600_000;

describe('sweepIdleNamespaces', () => {
  test('removes a namespace whose newest key is idle longer than the limit', async () => {
    const redis = fakeKeyspace({
      't3-dead:v1:a': { idleSeconds: 7_300 },
      't3-dead:v1:b': { idleSeconds: 9_000 },
      't3-live:v1:a': { idleSeconds: 5 },
    });

    const swept = await sweepIdleNamespaces(redis, {
      prefix: 't3-',
      idleMs: HOUR_MS,
    });

    assert({
      given: 'one namespace idle for over two hours and one used seconds ago',
      should: 'delete only the idle namespace and report it',
      actual: { swept, left: redis.keys() },
      expected: {
        swept: { namespaces: ['t3-dead'], keys: 2 },
        left: ['t3-live:v1:a'],
      },
    });
  });

  test('keeps a namespace when any one of its keys is fresh', async () => {
    const redis = fakeKeyspace({
      't3-run:v1:a': { idleSeconds: 90_000 },
      't3-run:v1:b': { idleSeconds: 90_000 },
      't3-run:v1:c': { idleSeconds: 3 },
    });

    const swept = await sweepIdleNamespaces(redis, {
      prefix: 't3-',
      idleMs: HOUR_MS,
    });

    assert({
      given:
        'a namespace with old keys and one key touched seconds ago (a run in progress, possibly in another process)',
      should: 'leave every key of it in place',
      actual: { swept, left: redis.keys().length },
      expected: { swept: { namespaces: [], keys: 0 }, left: 3 },
    });
  });

  test('never touches a key outside the prefix', async () => {
    const redis = fakeKeyspace({
      'offense-demo-wt-x:v1:a': { idleSeconds: 999_999 },
      't3-dead:v1:a': { idleSeconds: 999_999 },
    });

    await sweepIdleNamespaces(redis, { prefix: 't3-', idleMs: HOUR_MS });

    assert({
      given: 'a long-idle key of a dev namespace beside a stale test namespace',
      should: 'keep the dev namespace',
      actual: redis.keys(),
      expected: ['offense-demo-wt-x:v1:a'],
    });
  });

  test('is a no-op on an empty keyspace and never flushes', async () => {
    const redis = fakeKeyspace({});

    const swept = await sweepIdleNamespaces(redis, {
      prefix: 't3-',
      idleMs: HOUR_MS,
    });

    assert({
      given: 'no keys',
      should: 'sweep nothing using only SCAN',
      actual: { swept, commands: redis.commands },
      expected: {
        swept: { namespaces: [], keys: 0 },
        commands: ['SCAN'],
      },
    });
  });

  test('a key that vanished between SCAN and OBJECT does not stop the sweep', async () => {
    const redis = fakeKeyspace({ 't3-gone:v1:a': { idleSeconds: 10_000 } });
    const send = redis.send.bind(redis);
    const flaky = {
      send: async (command: string, args: string[]) =>
        command === 'OBJECT' ? null : send(command, args),
    };

    const swept = await sweepIdleNamespaces(flaky, {
      prefix: 't3-',
      idleMs: HOUR_MS,
    });

    assert({
      given: 'a key that expired after SCAN listed it',
      should: 'not count it as fresh or stale',
      actual: swept,
      expected: { namespaces: [], keys: 0 },
    });
  });
});

describe('deleteKeysWithoutExpiry', () => {
  test('removes exactly the keys with no TTL and returns them', async () => {
    const redis = fakeKeyspace({
      'a:v1:forever': { idleSeconds: 1, pttl: -1 },
      'a:v1:soon': { idleSeconds: 1, pttl: 5_000 },
    });

    const removed = await deleteKeysWithoutExpiry(redis, 'a:*');

    assert({
      given: 'one immortal key and one expiring key',
      should: 'report and unlink only the immortal key',
      actual: { removed, left: redis.keys() },
      expected: { removed: ['a:v1:forever'], left: ['a:v1:soon'] },
    });
  });

  test('a pattern under one namespace scopes it, and a foreign key is never touched', async () => {
    const redis = fakeKeyspace({
      'a:v1:forever': { idleSeconds: 1, pttl: -1 },
      'b:v1:forever': { idleSeconds: 1, pttl: -1 },
    });

    const removed = await deleteKeysWithoutExpiry(redis, 'a:*');

    assert({
      given: 'an immortal key in this namespace and one in another',
      should: 'remove only the one matching the pattern',
      actual: { removed, left: redis.keys() },
      expected: { removed: ['a:v1:forever'], left: ['b:v1:forever'] },
    });
  });

  test('refuses a pattern that is not one namespace, star included: the whole-database sweep belongs to the runner, in scripts/', async () => {
    const redis = fakeKeyspace({});

    await expect(deleteKeysWithoutExpiry(redis, '*')).rejects.toThrow(
      'Invalid key pattern',
    );
    await expect(deleteKeysWithoutExpiry(redis, 'a*')).rejects.toThrow(
      'Invalid key pattern',
    );
    await expect(deleteKeysWithoutExpiry(redis, '*:v1:x')).rejects.toThrow(
      'Invalid key pattern',
    );
  });
});
