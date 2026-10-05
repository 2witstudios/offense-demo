import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { signPayload } from './notify-drive';
import { fetchOriginProbe } from './auth-alert-probe';
import { withHttpsReceiver } from './incidents-receiver.test-support';

setupRitewayBun();

const SCRIPT_PATH = join(import.meta.dir, 'auth-alert-probe.ts');

describe('fetchOriginProbe (ISSUE-156 major finding: unreachable origin must not throw)', () => {
  test('a healthy origin resolves ok with the exact security-header contract', async () => {
    using server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 200,
          headers: {
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'strict-transport-security': 'max-age=31536000; includeSubDomains',
            'referrer-policy': 'strict-origin-when-cross-origin',
          },
        }),
    });
    const result = await fetchOriginProbe(`http://127.0.0.1:${server.port}`);
    assert({
      given: 'a healthy /api/health/ready response',
      should: 'resolve ok with no issues',
      actual: result,
      expected: { ok: true, issues: [] },
    });
  });

  test('an entirely unreachable origin (connection refused) resolves not-ok naming the failure, never throws', async () => {
    // Port 1: refused immediately, no DNS lookup, no timeout — this is the
    // exact shape that previously crashed main() with a RangeError from
    // `new Response(null, { status: 0 })`.
    const result = await fetchOriginProbe('http://127.0.0.1:1');
    assert({
      given: 'an origin nothing is listening on',
      should: 'resolve not-ok, naming the request failure, not throw',
      actual: {
        ok: result.ok,
        namesFailure: result.issues.some((issue) =>
          issue.includes('/api/health/ready request failed'),
        ),
      },
      expected: { ok: false, namesFailure: true },
    });
  });
});

describe('main() end to end: an unreachable origin still posts to Incidents (ISSUE-156 major finding)', () => {
  test('an unreachable origin composes a message naming both failures and delivers it, signed, to the Incidents webhook', async () =>
    withHttpsReceiver(async (receiver) => {
      const secret = 'test-incidents-secret';
      // Bun.spawnSync blocks this process's event loop until the child
      // exits — the in-process HTTPS receiver above could never answer the
      // child's request while blocked, so this one proof spawns
      // asynchronously and awaits the exit instead.
      const child = Bun.spawn(
        [
          'bun',
          SCRIPT_PATH,
          '--origin',
          'http://127.0.0.1:1',
          '--run-url',
          'https://example.test/run/1',
        ],
        {
          env: {
            PATH: process.env.PATH ?? '',
            OPS_PROBE_TOKEN: 'dummy-token',
            PAGESPACE_INCIDENTS_WEBHOOK_URL: receiver.url,
            PAGESPACE_INCIDENTS_WEBHOOK_SECRET: secret,
            // The receiver's cert is self-signed for this one test run;
            // only this subprocess's outbound fetch is told to accept it.
            NODE_TLS_REJECT_UNAUTHORIZED: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const exitCode = await child.exited;
      const result = { exitCode };
      const posted = receiver.requests();
      const body = posted[0]
        ? (JSON.parse(posted[0].body) as { content: string })
        : undefined;
      const signatureValid =
        posted[0] !== undefined &&
        posted[0].headers.get('x-pagespace-signature') ===
          signPayload(
            secret,
            Number(posted[0].headers.get('x-pagespace-timestamp')),
            posted[0].body,
          );
      assert({
        given:
          'an origin refusing every connection (health check and /api/ops/alerts both unreachable)',
        should:
          'exit 0, having posted exactly one correctly-signed message naming both failures to the real Incidents webhook path, never crashing before it could post',
        actual: {
          exitCode: result.exitCode,
          postedCount: posted.length,
          namesHealthFailure:
            body?.content.includes('/api/health/ready request failed') ?? false,
          namesAlertsFailure:
            body?.content.includes('alert conditions unavailable') ?? false,
          namesRunUrl: body?.content.includes('example.test/run/1') ?? false,
          signatureValid,
        },
        expected: {
          exitCode: 0,
          postedCount: 1,
          namesHealthFailure: true,
          namesAlertsFailure: true,
          namesRunUrl: true,
          signatureValid: true,
        },
      });
    }));
});
