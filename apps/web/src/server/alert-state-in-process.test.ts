import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { ALERT_THRESHOLDS, evaluateAlerts } from './alert-state';
import { readAlertSnapshot } from './alert-snapshot';
import { emptySnapshot } from './alert-state.test-support';

setupRitewayBun();

const NOW = '2026-09-25T12:00:00.000Z';
const clock = { now: () => NOW };

/**
 * ISSUE-191: the limiter shares the alert Redis, so its since-time is also
 * kept in process and must survive that Redis being unreadable.
 */
describe('alert state with the limiter kept in process (ISSUE-191)', () => {
  test('an unreadable alert Redis evaluates only the in-process limiter marker (ISSUE-191)', () => {
    const since = new Date(
      Date.parse(NOW) - ALERT_THRESHOLDS.unavailableMs,
    ).toISOString();
    assert({
      given:
        'a snapshot whose Redis state could not be read, with the limiter unavailable for 2 minutes in process',
      should:
        'fire limiter_unavailable and none of the Redis-backed conditions it could not read, cleanup_missed and a stale shed count included',
      actual: evaluateAlerts({
        nowIso: NOW,
        redisState: 'unreachable',
        storageUnavailableSinceIso: null,
        limiterUnavailableSinceIso: since,
        deliveryConsecutiveFailures: 0,
        authRequests: { total: 0, serverErrors: 0, windowMinutes: 10 },
        retentionLastSuccessIso: null,
        mailShed: { count: 500, windowMinutes: 10 },
        networkDenied: { count: 50_000, windowMinutes: 10 },
      }).map((c) => c.id),
      expected: ['limiter_unavailable'],
    });
  });

  test('takes the earlier of the Redis and in-process limiter since-times (ISSUE-191)', async () => {
    const earlier = '2026-09-25T11:57:00.000Z';
    const later = '2026-09-25T11:59:00.000Z';
    const redisWith = (since: string) => ({
      get: async (key: string) =>
        key === 'alert-unavailable-limiter' ? since : null,
    });
    const localWith = (since: string | null) => ({
      limiterUnavailableSince: () => since,
    });
    const sinceOf = async (redisSince: string, localSince: string | null) =>
      (
        await readAlertSnapshot({
          redis: redisWith(redisSince),
          clock,
          local: localWith(localSince),
        })
      ).limiterUnavailableSinceIso;
    assert({
      given:
        'a limiter since-time in Redis and one in process, either earlier, or none in process',
      should: 'report the earlier one, or the Redis one alone',
      actual: [
        await sinceOf(later, earlier),
        await sinceOf(earlier, later),
        await sinceOf(later, null),
      ],
      expected: [earlier, earlier, later],
    });
  });

  test('a Redis read failure yields an unreachable snapshot carrying the in-process limiter marker (ISSUE-191)', async () => {
    const since = '2026-09-25T11:57:00.000Z';
    const redis = {
      get: async (): Promise<string | null> => {
        throw new Error('redis down');
      },
    };
    assert({
      given:
        'every Redis read rejecting and the limiter unavailable in process',
      should:
        'answer a snapshot marked unreachable with the in-process since-time and nothing read from Redis',
      actual: await readAlertSnapshot({
        redis,
        clock,
        local: { limiterUnavailableSince: () => since },
      }),
      expected: {
        ...emptySnapshot(NOW, 'unreachable'),
        limiterUnavailableSinceIso: since,
      },
    });
  });

  test('a Redis that stops answering yields an unreachable snapshot within the read budget (ISSUE-208)', async () => {
    const since = '2026-09-25T11:57:00.000Z';
    const stalled = { get: () => new Promise<string | null>(() => {}) };
    const started = performance.now();
    const snapshot = await readAlertSnapshot({
      redis: stalled,
      clock,
      local: { limiterUnavailableSince: () => since },
      readTimeoutMs: 50,
    });
    assert({
      given:
        'every Redis read left pending forever, with a 50 ms per-command budget',
      should:
        'answer an unreachable snapshot carrying the in-process limiter marker within a second',
      actual: {
        redisState: snapshot.redisState,
        limiterSince: snapshot.limiterUnavailableSinceIso,
        withinBudget: performance.now() - started < 1000,
      },
      expected: {
        redisState: 'unreachable',
        limiterSince: since,
        withinBudget: true,
      },
    });
  });
});
