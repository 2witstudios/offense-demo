import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { decideProbeOutcome, fetchAlertConditions } from './auth-alert-probe';

setupRitewayBun();

describe('fetchAlertConditions (ISSUE-156)', () => {
  test('returns the conditions from a healthy 200 response', async () => {
    using server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        Response.json({
          conditions: [
            {
              id: 'cleanup_missed',
              summary: 'x',
              runbook:
                'docs/operations/auth-delivery.md#retention-cleanup-missed',
            },
          ],
          snapshot: { redisState: 'read' },
        }),
    });
    const result = await fetchAlertConditions(
      `http://127.0.0.1:${server.port}`,
      'token',
    );
    assert({
      given: 'a healthy /api/ops/alerts response',
      should: 'resolve ok with the conditions',
      actual: result,
      expected: {
        ok: true,
        conditions: [
          {
            id: 'cleanup_missed',
            summary: 'x',
            runbook:
              'docs/operations/auth-delivery.md#retention-cleanup-missed',
          },
        ],
        alertStateRead: true,
      },
    });
  });

  test('a non-2xx response from /api/ops/alerts resolves not-ok naming the status, never throws', async () => {
    using server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('down', { status: 500 }),
    });
    const result = await fetchAlertConditions(
      `http://127.0.0.1:${server.port}`,
      'token',
    );
    assert({
      given:
        'a 500 from /api/ops/alerts (e.g. Redis is unreachable server-side)',
      should: 'resolve not-ok naming the status, not throw',
      actual: result,
      expected: { ok: false, error: '/api/ops/alerts responded 500' },
    });
  });

  test('a 2xx body without a conditions array resolves not-ok, never ok with undefined conditions', async () => {
    using server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({}),
    });
    const result = await fetchAlertConditions(
      `http://127.0.0.1:${server.port}`,
      'token',
    );
    assert({
      given: 'a 200 from /api/ops/alerts whose JSON has no conditions array',
      should:
        'resolve not-ok naming an unreadable alert state and the missing conditions, not ok',
      actual: {
        ok: result.ok,
        namesUnreadable:
          !result.ok && result.error.includes('unreadable alert state'),
        namesConditions: !result.ok && result.error.includes('conditions'),
      },
      expected: { ok: false, namesUnreadable: true, namesConditions: true },
    });
  });

  test('a refused connection resolves not-ok naming the failure, never throws', async () => {
    const result = await fetchAlertConditions('http://127.0.0.1:1', 'token');
    assert({
      given: '/api/ops/alerts entirely unreachable (connection refused)',
      should: 'resolve not-ok, not throw',
      actual: result.ok,
      expected: false,
    });
  });
});

describe('decideProbeOutcome (ISSUE-156)', () => {
  const HEALTHY_ORIGIN = { ok: true, issues: [] };

  test('healthy origin and no fired conditions is healthy', () => {
    assert({
      given: 'a healthy origin probe and zero fired conditions',
      should: 'report healthy with no message',
      actual: decideProbeOutcome({
        originProbe: HEALTHY_ORIGIN,
        alertConditions: { ok: true, conditions: [], alertStateRead: true },
      }),
      expected: { healthy: true, message: null },
    });
  });

  test('an unreachable /api/ops/alerts is not-healthy and still produces a postable message, independent of the failing dependency', () => {
    const outcome = decideProbeOutcome({
      originProbe: HEALTHY_ORIGIN,
      alertConditions: {
        ok: false,
        error: '/api/ops/alerts request failed: fetch failed',
      },
    });
    assert({
      given:
        'a healthy origin but an unreachable /api/ops/alerts (Redis fully down)',
      should:
        'report not-healthy with a message naming the unreachable dependency, so posting to Incidents never depends on it answering',
      actual: {
        healthy: outcome.healthy,
        namesFailure:
          outcome.message?.includes('alert conditions unavailable') ?? false,
      },
      expected: { healthy: false, namesFailure: true },
    });
  });

  test('fired conditions with a healthy origin are not-healthy and named in the message', () => {
    const outcome = decideProbeOutcome({
      originProbe: HEALTHY_ORIGIN,
      alertConditions: {
        ok: true,
        alertStateRead: true,
        conditions: [
          {
            id: 'limiter_unavailable',
            summary: 'x',
            runbook:
              'docs/operations/auth-delivery.md#storage-or-rate-limiter-unavailable',
          },
        ],
      },
    });
    assert({
      given: 'a fired condition from a healthy /api/ops/alerts read',
      should: 'report not-healthy naming the condition',
      actual: {
        healthy: outcome.healthy,
        namesCondition:
          outcome.message?.includes('limiter_unavailable') ?? false,
      },
      expected: { healthy: false, namesCondition: true },
    });
  });
});
