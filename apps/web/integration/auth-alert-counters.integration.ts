import { afterAll } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { systemClock, systemId } from '@offense-demo/clock';
import { requireTestServices } from '@offense-demo/config';
import type { Fetch } from '../src/features/auth/mail';
import { createApp } from '../src/server/app';
import { LATENCY_BUCKETS_MS } from '../src/server/metrics-store';
import { createRoutes } from '../src/server/routes';
import { createTestApp } from './fixtures';
import { latencyHistogramOf, sampleOf, serveEdge } from './ops-edge';

requireTestServices(process.env);
setupRitewayBun();

const opsToken = `ops-${createId()}${createId()}`;

/**
 * ISSUE-173: real auth requests through the server start.ts runs
 * (`createProductionServer` over `createApp`'s composed logger) must reach
 * both AUTH-7.7 counters, `/api/ops/metrics`'s `auth_http_requests_total`
 * and `/api/ops/alerts`'s `authRequests.total`, exactly once each. On
 * staging 107 real 429s moved neither.
 */
describe('ISSUE-173 auth HTTP alert counters', () => {
  const { app, routes, freshEmail } = createTestApp({
    OPS_PROBE_TOKEN: opsToken,
  });

  test('each completed auth request counts once in /api/ops/metrics and /api/ops/alerts', async () => {
    const edge = await serveEdge({ app, routes, opsToken });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1)
        statuses.push(
          await edge.post('/api/auth/sign-in/magic-link', {
            email: freshEmail(),
          }),
        );
      const text = await edge.metricsText();
      const alertRequests = (await edge.alertSnapshot()).authRequests;
      assert({
        given:
          'five real magic-link requests from one client through the production server, three admitted and two rate limited',
        should:
          'count 3 in 2xx and 2 in 4xx on /api/ops/metrics, 2 rate-limit denials, and 5 requests, 0 server errors on /api/ops/alerts',
        actual: {
          statuses,
          metrics: Object.fromEntries(
            ['2xx', '3xx', '4xx', '5xx'].map((cls) => [
              cls,
              sampleOf(text, `auth_http_requests_total{status_class="${cls}"}`),
            ]),
          ),
          rateLimitDenied: sampleOf(text, 'auth_rate_limit_denied_total'),
          alertRequests,
        },
        expected: {
          statuses: [200, 200, 200, 429, 429],
          metrics: { '2xx': 3, '3xx': 0, '4xx': 2, '5xx': 0 },
          rateLimitDenied: 2,
          alertRequests: { total: 5, serverErrors: 0, windowMinutes: 10 },
        },
      });
    } finally {
      await edge.close();
    }
  });
});

/** The histogram `metrics-store.ts` should hold for these durations. */
const histogramFor = (durations: readonly number[]) => ({
  buckets: Object.fromEntries([
    ...LATENCY_BUCKETS_MS.map((boundary) => [
      String(boundary),
      durations.filter((duration) => duration <= boundary).length,
    ]),
    ['+Inf', durations.length],
  ]),
  sum: durations.reduce((total, duration) => total + duration, 0),
  count: durations.length,
});

/**
 * ISSUE-190: `auth_http_request_duration_ms` reads `operation` from the
 * fields `handleOperation` binds on its request child, the same cause that
 * kept ISSUE-173's counters at zero. Each real auth request must land in the
 * histogram once, in the bucket its own logged duration falls in.
 */
describe('ISSUE-190 auth request duration histogram', () => {
  const testApp = createTestApp({ OPS_PROBE_TOKEN: opsToken });
  // The provider answers the three admitted sends after these delays, so
  // the requests spread across buckets; each duration is then at least its
  // delay. The fourth request is rate limited and sends nothing.
  const mailDelaysMs = [0, 150, 300];
  const pendingDelays = [...mailDelaysMs];
  const delayedMail: Fetch = async (input, init) => {
    const delayMs = pendingDelays.shift() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return testApp.mailbox.fetch(input, init);
  };
  const logLines: string[] = [];
  const app = createApp({
    env: testApp.env,
    fetch: delayedMail,
    clock: systemClock,
    ids: systemId,
    logDestination: { write: (line) => logLines.push(line) },
  });
  afterAll(() => app.close());

  test('each completed auth request is observed once, in the bucket of its own duration', async () => {
    const edge = await serveEdge({ app, routes: createRoutes(app), opsToken });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 4; index += 1)
        statuses.push(
          await edge.post('/api/auth/sign-in/magic-link', {
            email: testApp.freshEmail(),
          }),
        );
      const histogram = latencyHistogramOf(
        await edge.metricsText(),
        'auth.request',
      );
      const durations = logLines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter(
          (record) =>
            record.event === 'http.request.completed' &&
            record.operation === 'auth.request',
        )
        .map((record) => Number(record.durationMs));
      assert({
        given:
          'four real magic-link requests through the production server, three admitted with mail answered after 0, 150 and 300 ms and one rate limited',
        should:
          'hold one observation per request in auth_http_request_duration_ms{operation="auth.request"}, bucketed and summed from each logged duration',
        actual: {
          statuses,
          count: histogram?.count,
          histogram,
          durationsCoverDelays: durations.map(
            (duration, index) => duration >= (mailDelaysMs[index] ?? 0),
          ),
          sumNonNegative: (histogram?.sum ?? -1) >= 0,
        },
        expected: {
          statuses: [200, 200, 200, 429],
          count: 4,
          histogram: histogramFor(durations),
          durationsCoverDelays: [true, true, true, true],
          sumNonNegative: true,
        },
      });
    } finally {
      await edge.close();
    }
  });
});
