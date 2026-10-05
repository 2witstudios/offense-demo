import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { decideProbeOutcome } from './auth-alert-probe';

import { alertsFrom } from './auth-alert-probe.test-support';

setupRitewayBun();

const LIMITER_UNAVAILABLE = {
  id: 'limiter_unavailable',
  summary: 'Auth rate limiter unavailable since 2026-09-29T12:00:00.000Z',
  runbook:
    'docs/operations/auth-delivery.md#storage-or-rate-limiter-unavailable',
} as const;

/**
 * ISSUE-199: during a Redis outage `/api/ops/alerts` answers 200 with a
 * snapshot marked `redisState: "unreachable"`, having evaluated only
 * `limiter_unavailable`. The probe must post that whether or not readiness
 * passes, as it did when the endpoint answered 500.
 */
describe('the alert state the probe read (ISSUE-199)', () => {
  test('reports whether /api/ops/alerts read its alert state, failing closed', async () => {
    assert({
      given:
        'a 200 whose snapshot was read, one marked unreachable, and one with no snapshot at all',
      should: 'resolve ok for each and read the state only for the first',
      actual: [
        await alertsFrom({ conditions: [], snapshot: { redisState: 'read' } }),
        await alertsFrom({
          conditions: [],
          snapshot: { redisState: 'unreachable' },
        }),
        await alertsFrom({ conditions: [] }),
      ],
      expected: [
        { ok: true, conditions: [], alertStateRead: true },
        { ok: true, conditions: [], alertStateRead: false },
        { ok: true, conditions: [], alertStateRead: false },
      ],
    });
  });

  test('an unread alert state posts even with a healthy origin and no fired condition', () => {
    const outcome = decideProbeOutcome({
      originProbe: { ok: true, issues: [] },
      alertConditions: { ok: true, conditions: [], alertStateRead: false },
    });
    assert({
      given:
        'a healthy origin and /api/ops/alerts answering no condition from an unread alert state',
      should:
        'report not-healthy with a message naming the conditions that were not evaluated',
      actual: {
        healthy: outcome.healthy,
        namesSkipped:
          (outcome.message?.includes('alert state unread') ?? false) &&
          (outcome.message?.includes('auth_5xx_rate') ?? false),
      },
      expected: { healthy: false, namesSkipped: true },
    });
  });

  test('an unread alert state posts alongside the condition it still fired', () => {
    const outcome = decideProbeOutcome({
      originProbe: { ok: true, issues: [] },
      alertConditions: {
        ok: true,
        conditions: [LIMITER_UNAVAILABLE],
        alertStateRead: false,
      },
    });
    assert({
      given:
        'a healthy origin and limiter_unavailable fired from an unread alert state',
      should: 'post both the condition and the unread state',
      actual: {
        healthy: outcome.healthy,
        namesCondition:
          outcome.message?.includes('limiter_unavailable:') ?? false,
        namesUnread: outcome.message?.includes('alert state unread') ?? false,
      },
      expected: { healthy: false, namesCondition: true, namesUnread: true },
    });
  });
});
