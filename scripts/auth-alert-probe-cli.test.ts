import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { PROBE_FETCH_TIMEOUT_MS } from './auth-alert-probe';
import { withHttpsReceiver } from './incidents-receiver.test-support';
import { signPayload } from './notify-drive';

setupRitewayBun();

const SCRIPT_PATH = join(import.meta.dir, 'auth-alert-probe.ts');
const SECRET = 'test-incidents-secret';

const HEALTHY_READINESS = () =>
  new Response(null, {
    status: 200,
    headers: {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  });

/**
 * The real probe CLI against `origin`, posting to a real signed HTTPS
 * receiver. Spawned asynchronously: the origin and the receiver are served
 * from this process, so a blocking spawn would leave them unable to answer.
 */
const probeAgainst = (answer: (path: string) => Promise<Response> | Response) =>
  withHttpsReceiver(async (receiver) => {
    using origin = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // Never drop an unanswered request: a hung endpoint must stay hung.
      idleTimeout: 0,
      fetch: (request) => answer(new URL(request.url).pathname),
    });
    const started = performance.now();
    const child = Bun.spawn(
      ['bun', SCRIPT_PATH, '--origin', `http://127.0.0.1:${origin.port}`],
      {
        env: {
          PATH: process.env.PATH ?? '',
          OPS_PROBE_TOKEN: 'dummy-token',
          PAGESPACE_INCIDENTS_WEBHOOK_URL: receiver.url,
          PAGESPACE_INCIDENTS_WEBHOOK_SECRET: SECRET,
          // The receiver's cert is self-signed for this one run; only this
          // subprocess's outbound fetch is told to accept it.
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        cwd: join(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const exitCode = await child.exited;
    const elapsedMs = performance.now() - started;
    const posted = receiver.requests();
    const first = posted[0];
    return {
      exitCode,
      elapsedMs,
      posts: posted.length,
      content: first
        ? (JSON.parse(first.body) as { content: string }).content
        : '',
      signed:
        first !== undefined &&
        first.headers.get('x-pagespace-signature') ===
          signPayload(
            SECRET,
            Number(first.headers.get('x-pagespace-timestamp')),
            first.body,
          ),
    };
  });

describe('the probe CLI always posts (ISSUE-208, ISSUE-209)', () => {
  test('conditions [null] posts an unreadable alert state instead of crashing', async () => {
    const run = await probeAgainst((path) =>
      path === '/api/ops/alerts'
        ? Response.json({
            conditions: [null],
            snapshot: { redisState: 'read' },
          })
        : HEALTHY_READINESS(),
    );
    assert({
      given:
        'a healthy readiness and /api/ops/alerts answering 200 with conditions [null]',
      should:
        'post one signed message naming an unreadable alert state and exit 0',
      actual: {
        exitCode: run.exitCode,
        posts: run.posts,
        signed: run.signed,
        namesUnreadable: run.content.includes('unreadable alert state'),
      },
      expected: { exitCode: 0, posts: 1, signed: true, namesUnreadable: true },
    });
  });

  test(
    'a hung /api/ops/alerts with readiness 503 posts within the request budget',
    async () => {
      const run = await probeAgainst((path) =>
        path === '/api/ops/alerts'
          ? new Promise<Response>(() => {})
          : new Response(null, { status: 503 }),
      );
      assert({
        given:
          'readiness answering 503 and /api/ops/alerts accepting the request but never answering',
        should:
          'post one signed message naming both failures once the alerts budget runs out, and exit 0',
        actual: {
          exitCode: run.exitCode,
          posts: run.posts,
          signed: run.signed,
          namesReadiness: run.content.includes('readiness answered 503'),
          namesAlerts: run.content.includes('/api/ops/alerts request failed'),
          withinBudget: run.elapsedMs < PROBE_FETCH_TIMEOUT_MS + 15_000,
        },
        expected: {
          exitCode: 0,
          posts: 1,
          signed: true,
          namesReadiness: true,
          namesAlerts: true,
          withinBudget: true,
        },
      });
    },
    PROBE_FETCH_TIMEOUT_MS + 40_000,
  );
});
