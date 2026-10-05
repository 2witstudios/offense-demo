import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  PROBE_FETCH_TIMEOUT_MS,
  PROBE_JOB_LIMIT_MS,
  fetchAlertConditions,
  fetchOriginProbe,
  parseAlertsBody,
  runProbe,
  type ProbeDependencies,
} from './auth-alert-probe';
import {
  DEFAULT_RETRY_DELAYS_MS,
  NOTIFY_ATTEMPT_TIMEOUT_MS,
} from './notify-drive';

import { alertsFrom } from './auth-alert-probe.test-support';

setupRitewayBun();

/** An origin that accepts every request and never answers it. */
const hungOrigin = () =>
  Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Never drop an unanswered request: a hung endpoint must stay hung.
    idleTimeout: 0,
    fetch: () => new Promise<Response>(() => {}),
  });

const READ = { redisState: 'read' } as const;

describe('the probe bounds every request (ISSUE-208)', () => {
  test('a hung /api/ops/alerts and a hung readiness each end not-ok within the budget given', async () => {
    using server = hungOrigin();
    const origin = `http://127.0.0.1:${server.port}`;
    const started = performance.now();
    const [alerts, readiness] = await Promise.all([
      fetchAlertConditions(origin, 'token', 200),
      fetchOriginProbe(origin, 200),
    ]);
    const elapsedMs = performance.now() - started;
    assert({
      given: 'an origin that never answers, with a 200 ms budget',
      should:
        'resolve both requests not-ok, naming the failed request, well before a second has passed',
      actual: {
        alertsOk: alerts.ok,
        alertsNamed:
          !alerts.ok && alerts.error.includes('/api/ops/alerts request failed'),
        readinessOk: readiness.ok,
        readinessNamed: readiness.issues.some((issue) =>
          issue.includes('/api/health/ready request failed'),
        ),
        withinBudget: elapsedMs < 1000,
      },
      expected: {
        alertsOk: false,
        alertsNamed: true,
        readinessOk: false,
        readinessNamed: true,
        withinBudget: true,
      },
    });
  });

  test('the worst-case probe run fits well inside the workflow job limit', () => {
    const notifyWorstMs =
      (DEFAULT_RETRY_DELAYS_MS.length + 1) * NOTIFY_ATTEMPT_TIMEOUT_MS +
      DEFAULT_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
    const worstMs = 2 * PROBE_FETCH_TIMEOUT_MS + notifyWorstMs;
    assert({
      given:
        'both probe requests timing out and every Incidents delivery attempt timing out',
      should:
        'still finish within half the 5-minute job limit, leaving the rest for checkout and setup',
      actual: {
        jobLimitMs: PROBE_JOB_LIMIT_MS,
        fitsInHalf: worstMs <= PROBE_JOB_LIMIT_MS / 2,
      },
      expected: { jobLimitMs: 300_000, fitsInHalf: true },
    });
  });
});

describe('the probe fails closed on an unexpected body (ISSUE-209)', () => {
  test('a malformed conditions list resolves not-ok as an unreadable alert state', async () => {
    const bodies = [
      { conditions: [null], snapshot: READ },
      { conditions: 'x', snapshot: READ },
      {
        conditions: [{ id: 'mystery', summary: 's', runbook: 'r' }],
        snapshot: READ,
      },
      { conditions: [{ id: 'cleanup_missed', runbook: 'r' }], snapshot: READ },
    ];
    const results = await Promise.all(bodies.map(alertsFrom));
    assert({
      given:
        'a 200 whose conditions hold null, is not an array, name an unknown condition kind, or lack a summary',
      should: 'resolve each not-ok, naming an unreadable alert state',
      actual: results.map(
        (result) =>
          !result.ok && result.error.includes('unreadable alert state'),
      ),
      expected: [true, true, true, true],
    });
  });

  test('a probe that throws before deciding still posts, then exits non-zero', async () => {
    const posted: string[] = [];
    const logged: string[] = [];
    const dependencies: ProbeDependencies = {
      fetchOriginProbe: async () => ({ ok: true, issues: [] }),
      fetchAlertConditions: async () => ({
        ok: true,
        conditions: [],
        alertStateRead: true,
      }),
      decide: () => {
        throw new Error('compose exploded');
      },
      notify: (message) => {
        posted.push(message);
        return true;
      },
      log: (line) => {
        logged.push(line);
      },
    };
    const exitCode = await runProbe(
      {
        origin: 'https://origin.test',
        token: 't',
        runUrl: 'https://run.test/1',
      },
      dependencies,
    );
    assert({
      given: 'a decision step that throws',
      should:
        'post one fail-closed unreadable-alert-state message naming the error and the run, and exit 1',
      actual: {
        exitCode,
        posts: posted.length,
        namesUnreadable: posted[0]?.includes('unreadable alert state') ?? false,
        namesError: posted[0]?.includes('compose exploded') ?? false,
        namesRun: posted[0]?.includes('https://run.test/1') ?? false,
        logged: logged.length,
      },
      expected: {
        exitCode: 1,
        posts: 1,
        namesUnreadable: true,
        namesError: true,
        namesRun: true,
        logged: 1,
      },
    });
  });
});

describe('parseAlertsBody (ISSUE-209, ISSUE-225)', () => {
  test('accepts only an object whose conditions are known conditions, failing closed on everything else', () => {
    const condition = { id: 'cleanup_missed', summary: 's', runbook: 'r' };
    const bodies = [
      { conditions: [condition], snapshot: READ },
      { conditions: [], snapshot: null },
      { conditions: [{ ...condition, extra: 1 }] },
      null,
      [],
      'text',
      { conditions: [condition, null] },
      { conditions: [{ ...condition, summary: 1 }] },
      { conditions: [{ ...condition, runbook: undefined }] },
    ];
    assert({
      given:
        'a valid body read, one with a null snapshot, one with an extra field, then null, an array, a string, a null entry, a numeric summary and a missing runbook',
      should:
        'accept the first three (read only for the first) and reject each of the rest',
      actual: bodies.map((body) => {
        const parsed = parseAlertsBody(body);
        return parsed.ok ? `ok read=${parsed.alertStateRead}` : 'unreadable';
      }),
      expected: [
        'ok read=true',
        'ok read=false',
        'ok read=false',
        'unreadable',
        'unreadable',
        'unreadable',
        'unreadable',
        'unreadable',
        'unreadable',
      ],
    });
  });

  test('accepts the shed and network conditions, so a flood is posted (ISSUE-220, AUTH-3.10)', () => {
    const parsed = parseAlertsBody({
      conditions: [
        { id: 'mail_shed', summary: 's', runbook: 'r' },
        { id: 'network_limited', summary: 's', runbook: 'r' },
      ],
      snapshot: READ,
    });
    assert({
      given: 'a read body firing mail_shed and network_limited',
      should: 'accept both as known conditions',
      actual: parsed.ok && parsed.conditions.map(({ id }) => id),
      expected: ['mail_shed', 'network_limited'],
    });
  });
});
