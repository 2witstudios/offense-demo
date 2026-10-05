import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readAlertSnapshot } from './alert-snapshot';
import { emptySnapshot } from './alert-state.test-support';

setupRitewayBun();

const NOW = '2026-09-25T12:00:00.000Z';

describe('readAlertSnapshot (AUTH-7.7)', () => {
  const clock = { now: () => NOW };
  const noLocalOutage = { limiterUnavailableSince: () => null };

  test('reads each durable marker and sums the request window', async () => {
    const currentBucket = Math.floor(Date.parse(NOW) / 60_000);
    const values = new Map<string, string>([
      ['alert-unavailable-storage', '2026-09-25T11:58:00.000Z'],
      ['alert-mail-consecutive-failures', '2'],
      ['alert-retention-last-success', '2026-09-25T11:00:00.000Z'],
      [`alert-http-total-${currentBucket}`, '40'],
      [`alert-http-5xx-${currentBucket}`, '1'],
      [`alert-http-total-${currentBucket - 5}`, '60'],
      [`alert-http-5xx-${currentBucket - 5}`, '2'],
      [`alert-mail-shed-${currentBucket}`, '15'],
      [`alert-mail-shed-${currentBucket - 9}`, '7'],
      [`alert-mail-shed-${currentBucket - 10}`, '100'],
      [`alert-network-denied-${currentBucket - 1}`, '400'],
      [`alert-network-denied-${currentBucket - 10}`, '9000'],
    ]);
    const redis = { get: async (key: string) => values.get(key) ?? null };
    assert({
      given:
        'markers spread across the 10-minute request and shed windows, and a shed bucket just outside',
      should: 'assemble one snapshot summing every bucket in range only',
      actual: await readAlertSnapshot({ redis, clock, local: noLocalOutage }),
      expected: {
        nowIso: NOW,
        redisState: 'read',
        storageUnavailableSinceIso: '2026-09-25T11:58:00.000Z',
        limiterUnavailableSinceIso: null,
        deliveryConsecutiveFailures: 2,
        authRequests: { total: 100, serverErrors: 3, windowMinutes: 10 },
        retentionLastSuccessIso: '2026-09-25T11:00:00.000Z',
        mailShed: { count: 22, windowMinutes: 10 },
        networkDenied: { count: 400, windowMinutes: 10 },
      },
    });
  });

  test('an all-absent Redis state reads as a clean, never-alerted snapshot', async () => {
    const redis = { get: async () => null };
    assert({
      given: 'no markers set at all',
      should: 'default counts to zero and timestamps to null',
      actual: await readAlertSnapshot({ redis, clock, local: noLocalOutage }),
      expected: emptySnapshot(NOW),
    });
  });
});
