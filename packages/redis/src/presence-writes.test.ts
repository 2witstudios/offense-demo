import { expect } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestRedis } from './test-support';

setupRitewayBun();

/** The script loads and EVALSHA calls among the recorded commands. */
const scriptCommands = (
  commands: ReadonlyArray<{ command: string; args: readonly string[] }>,
) => ({
  loads: commands.filter(
    ({ command, args }) => command === 'SCRIPT' && args[0] === 'LOAD',
  ),
  evalshas: commands.filter(({ command }) => command === 'EVALSHA'),
});

describe('presence lease upsert', () => {
  test('loads the script once and runs it by SHA1, over three namespaced keys with the TTL, userId, activity, instanceId and connId; no client-computed score or now', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await redis.upsertPresenceLease(
      {
        connId: 'conn1',
        userId,
        instanceId: 'inst1',
        activity: 'active',
      },
      60,
    );
    const { loads, evalshas } = scriptCommands(commands);
    const evals = commands.filter(({ command }) => command === 'EVAL');
    assert({
      given: 'a presence lease upsert',
      should:
        'load the script once and issue one EVALSHA over three namespaced keys with the TTL, userId, activity, instanceId and connId, never a raw EVAL',
      actual: {
        loadCount: loads.length,
        evalCount: evals.length,
        evalshaCount: evalshas.length,
        keyCount: evalshas[0]?.args[1],
        keys: evalshas[0]?.args.slice(2, 5),
        rest: evalshas[0]?.args.slice(5),
      },
      expected: {
        loadCount: 1,
        evalCount: 0,
        evalshaCount: 1,
        keyCount: '3',
        keys: [
          `test:v1:presence:conn:conn1`,
          `test:v1:presence:user:${userId}`,
          'test:v1:presence:online',
        ],
        rest: [userId, 'active', 'inst1', '60000', 'conn1'],
      },
    });
  });

  test('reloads and retries once on NOSCRIPT rather than failing the call', async () => {
    const userId = createId();
    const { redis, commands, simulateNoScriptOnce } = createTestRedis();
    simulateNoScriptOnce();
    await redis.upsertPresenceLease(
      { connId: 'conn1', userId, instanceId: 'inst1', activity: 'active' },
      60,
    );
    const { loads, evalshas } = scriptCommands(commands);
    assert({
      given: 'a NOSCRIPT error on the first EVALSHA',
      should: 'reload the script and retry exactly once, succeeding',
      actual: { loadCount: loads.length, evalshaCount: evalshas.length },
      expected: { loadCount: 2, evalshaCount: 2 },
    });
  });

  test('reuses the cached SHA1 across repeated calls, loading only once', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await redis.upsertPresenceLease(
      { connId: 'conn1', userId, instanceId: 'inst1', activity: 'active' },
      60,
    );
    await redis.upsertPresenceLease(
      { connId: 'conn2', userId, instanceId: 'inst1', activity: 'active' },
      60,
    );
    const loads = commands.filter(
      ({ command, args }) => command === 'SCRIPT' && args[0] === 'LOAD',
    );
    assert({
      given: 'two upserts against the same runner',
      should: 'load the upsert script only once',
      actual: loads.length,
      expected: 1,
    });
  });

  test('rejects invalid ids, activity and TTLs before touching Redis', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await expect(
      redis.upsertPresenceLease(
        {
          connId: 'bad key!',
          userId,
          instanceId: 'inst1',
          activity: 'active',
        },
        60,
      ),
    ).rejects.toThrow('Invalid connId');
    await expect(
      redis.upsertPresenceLease(
        {
          connId: 'conn1',
          userId: 'not-a-cuid2',
          instanceId: 'inst1',
          activity: 'active',
        },
        60,
      ),
    ).rejects.toThrow('Invalid userId');
    await expect(
      redis.upsertPresenceLease(
        {
          connId: 'conn1',
          userId,
          instanceId: 'inst1',
          // @ts-expect-error deliberately invalid at the runtime boundary
          activity: 'whatever',
        },
        60,
      ),
    ).rejects.toThrow('Invalid activity');
    await expect(
      redis.upsertPresenceLease(
        {
          connId: 'conn1',
          userId,
          instanceId: 'inst1',
          activity: 'active',
        },
        0,
      ),
    ).rejects.toThrow('TTL must be a positive integer');
    assert({
      given: 'an invalid connId, userId, activity value, or TTL',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });
});

describe('presence lease refresh', () => {
  test('extends the TTL and rescores the lease, with no client-computed score', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await redis.refreshPresenceLease({ connId: 'conn1', userId }, 60);
    const evalshas = commands.filter(({ command }) => command === 'EVALSHA');
    assert({
      given: 'a refresh of a live lease',
      should: 'issue one EVALSHA with the new TTL, connId and userId',
      actual: evalshas[0]?.args.slice(2),
      expected: [
        'test:v1:presence:conn:conn1',
        `test:v1:presence:user:${userId}`,
        'test:v1:presence:online',
        '60000',
        'conn1',
        userId,
      ],
    });
  });

  test('reports refreshed: false when the underlying lease already expired', async () => {
    const userId = createId();
    const { redis, scriptEval } = createTestRedis();
    scriptEval(0);
    assert({
      given: 'a refresh whose connection hash already TTL’d out',
      should: 'return refreshed: false rather than resurrecting the lease',
      actual: await redis.refreshPresenceLease({ connId: 'conn1', userId }, 60),
      expected: { refreshed: false },
    });
  });

  test('rejects an invalid TTL before touching Redis', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await expect(
      redis.refreshPresenceLease({ connId: 'conn1', userId }, 0),
    ).rejects.toThrow('TTL must be a positive integer');
    assert({
      given: 'an invalid TTL',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });
});

describe('presence lease delete', () => {
  test('runs one namespaced EVALSHA over the conn, user and online keys', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await redis.deletePresenceLease({ connId: 'conn1', userId });
    const evalshas = commands.filter(({ command }) => command === 'EVALSHA');
    assert({
      given: 'a clean disconnect',
      should: 'issue one EVALSHA naming the connId and userId',
      actual: evalshas[0]?.args.slice(2),
      expected: [
        'test:v1:presence:conn:conn1',
        `test:v1:presence:user:${userId}`,
        'test:v1:presence:online',
        'conn1',
        userId,
      ],
    });
  });

  test('rejects invalid ids before touching Redis', async () => {
    const userId = createId();
    const { redis, commands } = createTestRedis();
    await expect(
      redis.deletePresenceLease({ connId: 'bad key!', userId }),
    ).rejects.toThrow('Invalid connId');
    assert({
      given: 'an invalid connId',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });
});
