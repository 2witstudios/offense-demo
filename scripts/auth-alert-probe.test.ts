import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  composeAlertMessage,
  evaluateOriginProbe,
  resolveProbeConfig,
  resolveProbeToken,
} from './auth-alert-probe';

setupRitewayBun();

const SCRIPT_PATH = join(import.meta.dir, 'auth-alert-probe.ts');

/**
 * Runs the real script as a subprocess — the only way to prove `main()`
 * itself refuses, since it calls `process.exit` directly and cannot be
 * invoked in-process without killing the test runner. Port 1 on localhost
 * refuses the connection immediately (no DNS lookup, no timeout), so a
 * regression that proceeds past the refusal check still fails fast rather
 * than hanging.
 */
function spawnProbe(args: readonly string[]) {
  return Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('resolveProbeToken (ISSUE-144)', () => {
  test('reads the bearer token from the environment', () => {
    assert({
      given: 'an environment with OPS_PROBE_TOKEN set',
      should: 'return that value',
      actual: resolveProbeToken({ OPS_PROBE_TOKEN: 'env-value' }),
      expected: 'env-value',
    });
  });

  test('takes no command-line arguments, so a --token flag can never reach it', () => {
    // resolveProbeToken's only parameter is the environment record — there
    // is no args parameter for a --token flag to occupy, so this call site
    // is itself proof the flag is no longer accepted; TypeScript would
    // refuse a second argument if one were added back.
    assert({
      given: "resolveProbeToken's exported signature",
      should: 'accept exactly one parameter (the environment)',
      actual: resolveProbeToken.length,
      expected: 1,
    });
  });
});

describe('resolveProbeConfig (ISSUE-144 regression guard)', () => {
  test('refuses a --token flag with no OPS_PROBE_TOKEN in the environment', () => {
    // If main (or its arg parser) ever read --token as a fallback source
    // again, this would resolve a config instead of refusing.
    assert({
      given: '--origin and --token on the command line, no OPS_PROBE_TOKEN set',
      should: 'refuse (return undefined) rather than accept the --token value',
      actual: resolveProbeConfig(
        ['--origin', 'https://example.test', '--token', 'sneaky-value'],
        {},
      ),
      expected: undefined,
    });
  });

  test('uses OPS_PROBE_TOKEN from the environment, ignoring an unrelated --token flag', () => {
    assert({
      given:
        'OPS_PROBE_TOKEN in the environment and a --token flag with a different value',
      should:
        'resolve a config carrying the environment value, never the flag value',
      actual: resolveProbeConfig(
        ['--origin', 'https://example.test', '--token', 'ignored-value'],
        { OPS_PROBE_TOKEN: 'real-value' },
      ),
      expected: {
        origin: 'https://example.test',
        token: 'real-value',
        runUrl: undefined,
      },
    });
  });
});

describe('main() (AUTH-7.15 regression guard)', () => {
  test('exits 2 with the usage error and sends no request, given --token but no OPS_PROBE_TOKEN', () => {
    // Drives the real script, not resolveProbeConfig in isolation: a
    // rewrite of main() that stops calling resolveProbeConfig at all, or
    // one that reintroduces --token as a fallback inside it, both change
    // this process's observable exit code and stderr, so either regression
    // fails this test regardless of which function it lives in.
    const result = spawnProbe([
      '--origin',
      'http://127.0.0.1:1',
      '--token',
      'sneaky-value',
    ]);
    assert({
      given: '--origin and --token on the command line, no OPS_PROBE_TOKEN set',
      should: 'exit 2 with the usage error, never reaching a fetch',
      actual: {
        exitCode: result.exitCode,
        stderrHasUsage: result.stderr.toString().includes('usage:'),
      },
      expected: { exitCode: 2, stderrHasUsage: true },
    });
  });
});

const HEALTHY_HEADERS = new Map<string, string>([
  ['x-content-type-options', 'nosniff'],
  ['x-frame-options', 'DENY'],
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
]);

describe('evaluateOriginProbe (AUTH-7.7)', () => {
  test('a 200 with every required security header proves ok', () => {
    assert({
      given: 'a ready 200 carrying the exact security-header contract',
      should: 'report ok with no issues',
      actual: evaluateOriginProbe({ status: 200, headers: HEALTHY_HEADERS }),
      expected: { ok: true, issues: [] },
    });
  });

  test('a non-200 carrying the app headers is the app reporting not ready (ISSUE-203)', () => {
    const result = evaluateOriginProbe({
      status: 503,
      headers: HEALTHY_HEADERS,
    });
    assert({
      given:
        'a 503 carrying the app header contract (dependency down or draining)',
      should:
        'report exactly one issue naming the status and that the app reported not ready',
      actual: {
        ok: result.ok,
        count: result.issues.length,
        namesStatus: result.issues[0]?.includes('503'),
        saysNotReady: result.issues[0]?.includes('the app reported not ready'),
        saysNotApp: result.issues[0]?.includes('did not come from the app'),
      },
      expected: {
        ok: false,
        count: 1,
        namesStatus: true,
        saysNotReady: true,
        saysNotApp: false,
      },
    });
  });

  test('a non-5xx non-200 is not ok even with every header (ISSUE-203)', () => {
    const result = evaluateOriginProbe({
      status: 404,
      headers: HEALTHY_HEADERS,
    });
    assert({
      given: 'a 404 from the readiness endpoint carrying every required header',
      should: 'report not-ok naming the status',
      actual: {
        ok: result.ok,
        namesStatus: result.issues.some((i) => i.includes('404')),
      },
      expected: { ok: false, namesStatus: true },
    });
  });

  test('a non-200 with none of the app headers is one issue, not one per header (ISSUE-196)', () => {
    const result = evaluateOriginProbe({ status: 503, headers: new Map() });
    assert({
      given:
        'a 503 carrying none of the app headers (Fly proxy cold start or start-up gate)',
      should:
        'report exactly one issue naming the status and that the app likely did not answer',
      actual: {
        ok: result.ok,
        count: result.issues.length,
        namesStatus: result.issues[0]?.includes('503'),
        saysNotApp: result.issues[0]?.includes('did not come from the app'),
      },
      expected: { ok: false, count: 1, namesStatus: true, saysNotApp: true },
    });
  });

  test('a 200 reports every header mismatch, one issue each (ISSUE-196)', () => {
    const headers = new Map(HEALTHY_HEADERS);
    headers.delete('strict-transport-security');
    headers.set('x-frame-options', 'SAMEORIGIN');
    assert({
      given:
        'a 200 missing Strict-Transport-Security and weakening X-Frame-Options',
      should: 'report both mismatches',
      actual: evaluateOriginProbe({ status: 200, headers }),
      expected: {
        ok: false,
        issues: [
          'x-frame-options: expected "DENY", got SAMEORIGIN',
          'strict-transport-security: expected "max-age=31536000; includeSubDomains", got none',
        ],
      },
    });
  });

  test('a missing security header is reported by name', () => {
    const headers = new Map(HEALTHY_HEADERS);
    headers.delete('strict-transport-security');
    const result = evaluateOriginProbe({ status: 200, headers });
    assert({
      given: 'a response missing Strict-Transport-Security',
      should: 'report not-ok naming that header',
      actual: {
        ok: result.ok,
        namesHeader: result.issues.some((i) =>
          i.includes('strict-transport-security'),
        ),
      },
      expected: { ok: false, namesHeader: true },
    });
  });

  test('a wrong header value is reported, not silently accepted', () => {
    const headers = new Map(HEALTHY_HEADERS);
    headers.set('x-frame-options', 'SAMEORIGIN');
    const result = evaluateOriginProbe({ status: 200, headers });
    assert({
      given: 'X-Frame-Options present but weaker than the configured DENY',
      should: 'report not-ok',
      actual: result.ok,
      expected: false,
    });
  });
});

describe('composeAlertMessage (AUTH-7.7)', () => {
  test('names every fired condition with its own runbook and any origin issue', () => {
    const message = composeAlertMessage({
      conditions: [
        {
          id: 'cleanup_missed',
          summary: 'Retention sweep last succeeded 2026-09-25T09:00:00.000Z',
          runbook: 'docs/operations/auth-delivery.md#retention-cleanup-missed',
        },
      ],
      originIssues: ['strict-transport-security: expected "...", got none'],
      runUrl: 'https://github.com/2witstudios/offense-demo/actions/runs/1',
    });
    assert({
      given: 'one fired condition and one origin-probe issue',
      should:
        'include the condition id, its runbook, the origin issue, and the run URL',
      actual: {
        hasCondition: message.includes('cleanup_missed'),
        hasRunbook: message.includes(
          'auth-delivery.md#retention-cleanup-missed',
        ),
        hasOriginIssue: message.includes('strict-transport-security'),
        hasRunUrl: message.includes('actions/runs/1'),
      },
      expected: {
        hasCondition: true,
        hasRunbook: true,
        hasOriginIssue: true,
        hasRunUrl: true,
      },
    });
  });

  test('an empty condition and issue list still composes a message (negative control never reached in main())', () => {
    assert({
      given: 'no conditions and no origin issues',
      should: 'still return the header line',
      actual: composeAlertMessage({ conditions: [], originIssues: [] }),
      expected: '🔴 AUTH-7.7 alert probe',
    });
  });
});
