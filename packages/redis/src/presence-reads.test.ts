import { expect } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestRedis } from './test-support';

setupRitewayBun();

describe('presence reads', () => {
  test('issues one EVALSHA per read, with no client-injected now, and parses the Redis now plus the flat hydrated record', async () => {
    const userId = createId();
    const { redis, scriptEval, commands } = createTestRedis();
    scriptEval([5000, 'conn1', userId, 'active', 'inst1', '9000']);
    const { connections, nowMs } = await redis.readUserConnections(userId);
    const evalshas = commands.filter(({ command }) => command === 'EVALSHA');
    assert({
      given: 'a live connection returned by the one-op read',
      should:
        'issue exactly one EVALSHA naming the user zset key, the userId, the conn-hash key prefix and the 32-connection bound, and parse the Redis now plus the flat 5-tuple',
      actual: {
        evalCount: evalshas.length,
        evalArgs: evalshas[0]?.args.slice(1),
        nowMs,
        connections,
      },
      expected: {
        evalCount: 1,
        evalArgs: [
          '1',
          `test:v1:presence:user:${userId}`,
          userId,
          'test:v1:presence:conn:',
          '32',
        ],
        nowMs: 5000,
        connections: [
          {
            connId: 'conn1',
            userId,
            activity: 'active',
            instanceId: 'inst1',
            expiresAtMs: 9000,
          },
        ],
      },
    });
  });

  test('reads the online set in one bounded EVALSHA with no client-injected now, returning the Redis now alongside the pairs', async () => {
    const { redis, scriptEval, commands } = createTestRedis();
    const user1 = createId();
    const user2 = createId();
    scriptEval([5000, user1, '9000', user2, '12000']);
    const { users, nowMs } = await redis.readOnlinePresence(100);
    const evalshas = commands.filter(({ command }) => command === 'EVALSHA');
    assert({
      given: 'the online set with two live users',
      should:
        'issue one EVALSHA naming the online key and the limit, and parse the Redis now plus the pairs',
      actual: {
        evalCount: evalshas.length,
        evalArgs: evalshas[0]?.args.slice(1),
        nowMs,
        users,
      },
      expected: {
        evalCount: 1,
        evalArgs: ['1', 'test:v1:presence:online', '100'],
        nowMs: 5000,
        users: [
          { userId: user1, expiresAtMs: 9000 },
          { userId: user2, expiresAtMs: 12000 },
        ],
      },
    });
  });

  test('rejects a non-positive-integer limit before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(redis.readOnlinePresence(0)).rejects.toThrow(
      'Limit must be a positive integer',
    );
    assert({
      given: 'an invalid limit',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });

  test('rejects an invalid userId before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(redis.readUserConnections('bad id!')).rejects.toThrow(
      'Invalid userId',
    );
    assert({
      given: 'an invalid userId',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });
});

describe('presence limits', () => {
  test('refuses a read or sweep limit over the cap before touching Redis, and accepts the cap', async () => {
    const { redis, scriptEval, commands } = createTestRedis();
    const refused = await Promise.all([
      redis.readOnlinePresence(1001).then(
        () => 'ran',
        (error: Error) => error.message,
      ),
      redis.sweepOnlinePresence(1001).then(
        () => 'ran',
        (error: Error) => error.message,
      ),
    ]);
    const refusedCommands = commands.length;
    scriptEval(0);
    const atCap = await redis.sweepOnlinePresence(1000);
    assert({
      given: 'a limit of 1001, one over the cap, and then the cap itself',
      should:
        'refuse both over-cap calls with no Redis command, and run the sweep at the cap',
      actual: { refused, refusedCommands, atCap },
      expected: {
        refused: Array(2).fill(
          'Limit must be a positive integer no greater than 1000',
        ),
        refusedCommands: 0,
        atCap: 0,
      },
    });
  });
});

describe('presence sweep', () => {
  test('runs one bounded EVALSHA against the online key and returns the removed count', async () => {
    const { redis, scriptEval, commands } = createTestRedis();
    scriptEval(3);
    const removed = await redis.sweepOnlinePresence(50);
    const evalshas = commands.filter(({ command }) => command === 'EVALSHA');
    assert({
      given: 'a sweep of the online set',
      should:
        'issue one EVALSHA naming the online key and the limit, returning the removed count',
      actual: { evalArgs: evalshas[0]?.args.slice(1), removed },
      expected: {
        evalArgs: ['1', 'test:v1:presence:online', '50'],
        removed: 3,
      },
    });
  });

  test('rejects a non-positive-integer limit before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(redis.sweepOnlinePresence(0)).rejects.toThrow(
      'Limit must be a positive integer',
    );
    assert({
      given: 'an invalid sweep limit',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });
});
