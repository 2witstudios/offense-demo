import { expect } from 'bun:test';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createRedis } from '../src';
import { withRedis } from './test-support';

setupRitewayBun();

const { redisUrl: url } = requireTestServices(process.env);

test('ephemeral namespace roundtrip and cleanup', () =>
  withRedis(url, async ({ redis }) => {
    const healthy = await redis.health();
    await redis.setEphemeral('proof', 'value', 60);
    const stored = await redis.get('proof');
    await redis.delete('proof');
    assert({
      given: 'a value set, read back and deleted in a fresh namespace',
      should: 'report health, return the value, then nothing',
      actual: { healthy, stored, afterDelete: await redis.get('proof') },
      expected: { healthy: true, stored: 'value', afterDelete: null },
    });
  }));

test('rate limit admits exactly max across concurrent instances and expires atomically', () =>
  withRedis(url, async ({ namespace, redis, raw, key, expireNow }) => {
    // A second client over the same namespace stands in for a second
    // application instance sharing one Redis.
    const other = createRedis({ url, namespace });
    const rule = { windowSeconds: 2, max: 7 };
    try {
      const decisions = await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          (index % 2 === 0 ? redis : other).consumeRateLimit(
            'concurrent',
            rule,
          ),
        ),
      );
      const counterKey = key('rl', 'concurrent');
      const pttl = await raw.pttl(counterKey);
      assert({
        given: '100 concurrent consumes across two instances, max 7 in 2 s',
        should:
          'admit exactly 7, tell the rest to retry within the window, and expire the counter within it',
        actual: {
          allowed: decisions.filter((decision) => decision.allowed).length,
          retryAfter: [
            ...new Set(
              decisions
                .filter((decision) => !decision.allowed)
                .map((decision) => decision.retryAfterSeconds),
            ),
          ].every((seconds) => seconds >= 1 && seconds <= 2),
          expiresWithinWindow: pttl > 0 && pttl <= 2_000,
        },
        expected: { allowed: 7, retryAfter: true, expiresWithinWindow: true },
      });
      // The window's expiry fires: the same key admits again.
      await expireNow(counterKey);
      assert({
        given: 'the rate-limit window expiring',
        should: 'admit the same key again',
        actual: (await other.consumeRateLimit('concurrent', rule)).allowed,
        expected: true,
      });
    } finally {
      other.close();
    }
  }));

test('markOccurrenceSince keeps the since-value and re-arms the TTL on every later occurrence, bridging a continuous run past a single TTL window', () =>
  withRedis(url, async ({ redis, raw, key, expireNow }) => {
    const markerKey = key('marker');
    const ttlSeconds = 60;
    // Stands in for time passing: the marker is about to expire.
    const nearlyExpire = () => raw.send('PEXPIRE', [markerKey, '1000']);
    const first = await redis.markOccurrenceSince(
      'marker',
      'first',
      ttlSeconds,
    );
    await nearlyExpire();
    // A later occurrence keeps the original since-value and re-arms the TTL...
    const second = await redis.markOccurrenceSince(
      'marker',
      'second',
      ttlSeconds,
    );
    const ttlAfterSecond = await raw.pttl(markerKey);
    await nearlyExpire();
    // ...and so does the next: the condition's since-time never resets
    // during a continuous outage.
    const third = await redis.markOccurrenceSince(
      'marker',
      'third',
      ttlSeconds,
    );
    const ttlAfterThird = await raw.pttl(markerKey);
    assert({
      given:
        'three occurrences of the same condition, each arriving when the marker has 1s left of its TTL',
      should:
        'return the first value every time and re-arm the full TTL, never expiring between occurrences',
      actual: {
        first,
        second,
        third,
        rearmed: [ttlAfterSecond, ttlAfterThird].every((ttl) => ttl > 1_000),
      },
      expected: {
        first: 'first',
        second: 'first',
        third: 'first',
        rearmed: true,
      },
    });
    // Once occurrences stop, the marker still expires on its own.
    await expireNow(markerKey);
    assert({
      given: 'no further occurrence before the TTL runs out',
      should: 'let the marker expire so the condition clears passively',
      actual: await redis.get('marker'),
      expected: null,
    });
  }));

test('rate limit reports outage as a thrown error, never an allow', async () => {
  const dead = createRedis({
    url: 'redis://127.0.0.1:1',
    namespace: 'test-outage',
  });
  try {
    await expect(
      dead.consumeRateLimit('k', { windowSeconds: 60, max: 3 }),
    ).rejects.toMatchObject({ code: 'ERR_REDIS_CONNECTION_CLOSED' });
  } finally {
    dead.close();
  }
});
