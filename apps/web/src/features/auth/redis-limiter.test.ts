import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createAuthRateLimiter } from './redis-limiter';

setupRitewayBun();

const fakeRedis = (
  decision: unknown = { allowed: true, retryAfterSeconds: 0 },
) => {
  const calls: Array<{ key: string; rule: unknown }> = [];
  return {
    calls,
    redis: {
      consumeRateLimit: async (key: string, rule: unknown) => {
        calls.push({ key, rule });
        if (decision instanceof Error) throw decision;
        return decision as { allowed: boolean; retryAfterSeconds: number };
      },
    },
  };
};

describe('createAuthRateLimiter', () => {
  test('hashes untrusted identifiers into a valid key segment', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = createAuthRateLimiter(redis);
    await limiter.consume('203.0.113.9|/sign-in/magic-link|a@b.co', {
      windowSeconds: 60,
      max: 3,
    });
    assert({
      given: 'a raw key containing an IP, path and separators',
      should: 'pass a 64-hex SHA3-256 digest that carries none of the input',
      actual: {
        shape: /^[0-9a-f]{64}$/.test(calls[0]?.key ?? ''),
        leaksInput: (calls[0]?.key ?? '').includes('203'),
        rule: calls[0]?.rule,
      },
      expected: {
        shape: true,
        leaksInput: false,
        rule: { windowSeconds: 60, max: 3 },
      },
    });
  });

  test('is deterministic per identifier and distinct across identifiers', async () => {
    const { redis, calls } = fakeRedis();
    const limiter = createAuthRateLimiter(redis);
    const rule = { windowSeconds: 60, max: 3 };
    await limiter.consume('a', rule);
    await limiter.consume('a', rule);
    await limiter.consume('b', rule);
    assert({
      given: 'repeated and different identifiers',
      should: 'map equal keys to equal digests only',
      actual: [
        calls[0]?.key === calls[1]?.key,
        calls[0]?.key === calls[2]?.key,
      ],
      expected: [true, false],
    });
  });

  test('passes the decision through', async () => {
    const { redis } = fakeRedis({ allowed: false, retryAfterSeconds: 42 });
    assert({
      given: 'a denied Redis decision',
      should: 'report denial with retry seconds',
      actual: await createAuthRateLimiter(redis).consume('k', {
        windowSeconds: 60,
        max: 1,
      }),
      expected: { allowed: false, retryAfterSeconds: 42 },
    });
  });

  test('a Redis outage rejects instead of allowing or counting locally', async () => {
    const outage = new Error('redis down');
    const { redis } = fakeRedis(outage);
    const limiter = createAuthRateLimiter(redis);
    await expect(
      limiter.consume('k', { windowSeconds: 60, max: 1 }),
    ).rejects.toBe(outage);
    await expect(
      limiter.consume('k', { windowSeconds: 60, max: 1 }),
    ).rejects.toBe(outage);
  });
});
