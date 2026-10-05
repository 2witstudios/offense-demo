import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createOutageRedis, createTestRedis } from './test-support';

setupRitewayBun();

describe('redis alert counters (AUTH-7.7)', () => {
  test('markOccurrenceSince issues one namespaced EVAL carrying the value and TTL', async () => {
    const { redis, commands } = createTestRedis();
    await redis.markOccurrenceSince(
      'alert-unavailable-storage',
      '2026-09-25T00:00:00.000Z',
      180,
    );
    const evals = commands.filter(({ command }) => command === 'EVAL');
    assert({
      given: 'a first-observed marker with a positive TTL',
      should:
        'run exactly one Lua EVAL against one namespaced key with the value and TTL in ms',
      actual: {
        count: evals.length,
        key: evals[0]?.args[2],
        value: evals[0]?.args[3],
        ttlMs: evals[0]?.args[4],
      },
      expected: {
        count: 1,
        key: 'test:v1:alert-unavailable-storage',
        value: '2026-09-25T00:00:00.000Z',
        ttlMs: '180000',
      },
    });
  });

  test('markOccurrenceSince returns the stored value', async () => {
    const { redis, scriptEval } = createTestRedis();
    scriptEval('2026-09-25T00:00:00.000Z');
    assert({
      given: 'a script result returning the winning value',
      should: 'return that value to the caller',
      actual: await redis.markOccurrenceSince(
        'alert-unavailable-storage',
        'ignored',
        180,
      ),
      expected: '2026-09-25T00:00:00.000Z',
    });
  });

  test('markOccurrenceSince refuses a non-positive-integer TTL before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(redis.markOccurrenceSince('k', 'v', 0)).rejects.toThrow(
      'TTL must be a positive integer',
    );
    assert({
      given: 'an invalid TTL',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });

  test('incrementWithExpiry issues one namespaced EVAL carrying the TTL', async () => {
    const { redis, commands, scriptEval } = createTestRedis();
    scriptEval(1);
    await redis.incrementWithExpiry('alert-mail-consecutive-failures', 3600);
    const evals = commands.filter(({ command }) => command === 'EVAL');
    assert({
      given: 'a bounded counter increment with a positive TTL',
      should:
        'run exactly one Lua EVAL against one namespaced key with the TTL in ms',
      actual: {
        count: evals.length,
        key: evals[0]?.args[2],
        ttlMs: evals[0]?.args[3],
      },
      expected: {
        count: 1,
        key: 'test:v1:alert-mail-consecutive-failures',
        ttlMs: '3600000',
      },
    });
  });

  test('incrementWithExpiry returns the new count', async () => {
    const { redis, scriptEval } = createTestRedis();
    scriptEval(3);
    assert({
      given: 'a script result returning the incremented count',
      should: 'return that count to the caller',
      actual: await redis.incrementWithExpiry(
        'alert-mail-consecutive-failures',
        3600,
      ),
      expected: 3,
    });
  });

  test('incrementWithExpiry refuses a non-positive-integer TTL before touching Redis', async () => {
    const { redis, commands } = createTestRedis();
    await expect(redis.incrementWithExpiry('k', 0)).rejects.toThrow(
      'TTL must be a positive integer',
    );
    assert({
      given: 'an invalid TTL',
      should: 'issue no Redis command',
      actual: commands.length,
      expected: 0,
    });
  });

  test('propagates outage and reports it without swallowing', async () => {
    const { events, redis } = createOutageRedis();
    await expect(
      redis.markOccurrenceSince('alert-unavailable-storage', 'v', 180),
    ).rejects.toThrow('offline');
    await expect(
      redis.incrementWithExpiry('alert-mail-consecutive-failures', 3600),
    ).rejects.toThrow('offline');
    assert({
      given: 'an unreachable Redis',
      should: 'emit a failure event naming each operation',
      actual: events,
      expected: [
        {
          event: 'redis.command.failed',
          fields: { operation: 'markOccurrenceSince' },
        },
        {
          event: 'redis.command.failed',
          fields: { operation: 'incrementWithExpiry' },
        },
      ],
    });
  });
});
