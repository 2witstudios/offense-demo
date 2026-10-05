import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import nextConfig from '../next.config';
import {
  createRetentionSweep,
  retentionTargets,
} from '../src/server/retention-sweep';
import { createSelfSignedTlsEdge } from '../e2e/support/tls-edge';
import { ALERT_STATE_READ_TIMEOUT_MS } from '../src/server/alert-snapshot';
import { createFaultedApp } from './fault-proxy';
import { createTestApp } from './fixtures';

requireTestServices(process.env);
setupRitewayBun();

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../..');
const opsToken = `ops-${createId()}${createId()}`;
const INCIDENTS_SECRET = `incidents-${createId()}`;

/**
 * Next's response headers as production serves them (`next.config.ts`):
 * the stand-in origin below routes to the real handlers without Next, and
 * the probe's origin check reads these headers.
 */
async function productionHeaders(): Promise<Headers> {
  const [everyPath] = (await nextConfig.headers?.()) ?? [];
  const headers = new Headers(
    everyPath?.headers.map(({ key, value }) => [key, value]),
  );
  // next.config.ts adds this entry only when NODE_ENV is production.
  headers.set(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
  );
  return headers;
}

type IncidentsPost = { readonly body: string; readonly headers: Headers };

/**
 * A real Incidents receiver seam (ISSUE-210): a loopback server capturing
 * each post, behind the repository's self-signed TLS edge, since
 * notify-drive refuses a non-https webhook.
 */
function createIncidentsReceiver() {
  const posts: IncidentsPost[] = [];
  const capture = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      posts.push({ body: await request.text(), headers: request.headers });
      return new Response('ok');
    },
  });
  const edge = createSelfSignedTlsEdge({
    appPort: capture.port as number,
    edgePort: 0,
  });
  return {
    url: `https://127.0.0.1:${edge.port}`,
    posts: () => [...posts],
    stop: () => {
      edge.stop(true);
      void capture.stop(true);
    },
  };
}

/** Whether a post carries notify-drive's HMAC signature for `secret`. */
const signedWith = (secret: string, post: IncidentsPost) => {
  const timestamp = post.headers.get('x-pagespace-timestamp');
  return (
    post.headers.get('x-pagespace-signature') ===
    `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${post.body}`).digest('hex')}`
  );
};

/**
 * The real probe CLI, as the scheduled workflow runs it, against `origin`,
 * posting to `webhookUrl`. Asynchronous: the origin and the receiver are
 * served from this process, so a blocking spawn would leave them unable to
 * answer.
 */
async function runProbe(origin: string, webhookUrl: string) {
  const probe = Bun.spawn(
    ['bun', 'scripts/auth-alert-probe.ts', '--origin', origin],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        OPS_PROBE_TOKEN: opsToken,
        PAGESPACE_INCIDENTS_WEBHOOK_URL: webhookUrl,
        PAGESPACE_INCIDENTS_WEBHOOK_SECRET: INCIDENTS_SECRET,
        // The receiver's certificate is self-signed for this run; only this
        // subprocess's outbound fetch is told to accept it.
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(probe.stdout).text(),
    probe.exited,
  ]);
  return { stdout, exitCode };
}

/**
 * ISSUE-199: with Redis unreachable to the instance answering
 * `/api/ops/alerts` but readiness still passing (a GET failure while PING
 * passes, or an instance that never saw the limiter fail), the endpoint
 * answers 200 with no condition and `redisState: "unreachable"`. The probe
 * must post that, not report healthy.
 */
describe('ISSUE-199 the probe over an unreadable alert state', () => {
  const testApp = createTestApp({ OPS_PROBE_TOKEN: opsToken });
  const faulted = createFaultedApp(testApp, 'REDIS_URL');

  test('a healthy origin with an unreadable alert state posts the conditions it did not evaluate', async () => {
    // A completed sweep, so the readable state fires nothing (no cleanup_missed).
    await createRetentionSweep({
      targets: retentionTargets({
        database: testApp.app.database,
        redis: testApp.app.redis,
      }),
      clock: testApp.app.clock,
      logger: testApp.app.logger,
    }).run();
    const headers = await productionHeaders();
    using origin = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const response =
          path === '/api/health/ready'
            ? await testApp.routes.ready.GET(request)
            : path === '/api/ops/alerts'
              ? await faulted.routes.ops.alerts.GET(request)
              : new Response(null, { status: 404 });
        headers.forEach((value, key) => response.headers.set(key, value));
        return response;
      },
    });
    const originUrl = `http://127.0.0.1:${origin.port}`;
    const receiver = createIncidentsReceiver();
    try {
      const beforeOutage = await runProbe(originUrl, receiver.url);
      const postsBefore = receiver.posts().length;
      faulted.proxy.pause();
      const duringOutage = await runProbe(originUrl, receiver.url);
      faulted.proxy.resume();
      const [post] = receiver.posts().slice(postsBefore);
      const content = post
        ? (JSON.parse(post.body) as { content: string }).content
        : '';
      assert({
        given:
          "the real probe CLI against a healthy readiness, before and while the alerts instance's Redis is paused, posting to a real signed Incidents receiver",
        should:
          'report healthy and post nothing before, then deliver one signed post naming the unevaluated conditions and exit 0',
        actual: {
          before: {
            exitCode: beforeOutage.exitCode,
            healthy: beforeOutage.stdout.includes('healthy, nothing to report'),
            posts: postsBefore,
          },
          during: {
            exitCode: duringOutage.exitCode,
            posts: receiver.posts().length - postsBefore,
            signed: post !== undefined && signedWith(INCIDENTS_SECRET, post),
            namesUnread: content.includes('alert state unread'),
            namesSkipped: content.includes('auth_5xx_rate'),
            namesReadiness: content.includes('origin_probe: readiness'),
          },
        },
        expected: {
          before: { exitCode: 0, healthy: true, posts: 0 },
          during: {
            exitCode: 0,
            posts: 1,
            signed: true,
            namesUnread: true,
            namesSkipped: true,
            namesReadiness: false,
          },
        },
      });
    } finally {
      receiver.stop();
    }
  });
});

/**
 * ISSUE-208: a Redis that stops answering (connections open, nothing
 * relayed) must not hold `/api/ops/alerts` open: each read has its own
 * budget, and the endpoint answers an unreachable snapshot within it.
 */
describe('ISSUE-208 /api/ops/alerts over a stalled Redis', () => {
  const testApp = createTestApp({ OPS_PROBE_TOKEN: opsToken });
  const faulted = createFaultedApp(testApp, 'REDIS_URL');

  test('a Redis that stops answering yields an unreachable snapshot within the read budget', async () => {
    const alertsRequest = () =>
      new Request(`${testApp.origin}/api/ops/alerts`, {
        headers: { authorization: `Bearer ${opsToken}` },
      });
    const baseline = await faulted.routes.ops.alerts.GET(alertsRequest());
    faulted.proxy.stall();
    const started = performance.now();
    const stalled = await faulted.routes.ops.alerts.GET(alertsRequest());
    const elapsedMs = performance.now() - started;
    const body = (await stalled.json()) as {
      snapshot: { redisState: string };
    };
    faulted.proxy.resume();
    assert({
      given:
        'the real alerts handler, before and while its Redis connection stays open but answers nothing',
      should:
        'answer 200 before, then 200 with an unreachable snapshot within the per-read budget',
      actual: {
        baselineStatus: baseline.status,
        status: stalled.status,
        redisState: body.snapshot.redisState,
        withinBudget: elapsedMs < ALERT_STATE_READ_TIMEOUT_MS + 3_000,
      },
      expected: {
        baselineStatus: 200,
        status: 200,
        redisState: 'unreachable',
        withinBudget: true,
      },
    });
  });
});
