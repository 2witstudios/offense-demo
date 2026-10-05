import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  clientIpTrustIssues,
  cookieAttributeIssues,
  corsIssues,
  httpsRedirectIssues,
  noSharedCacheIssues,
  originEnforcementIssues,
  secretLeakIssues,
  type ProbeResponse,
} from './staging-security-probe';

setupRitewayBun();

const response = (
  status: number,
  headers: Readonly<Record<string, string>> = {},
): ProbeResponse => ({
  status,
  headers: new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  ),
});

describe('httpsRedirectIssues', () => {
  test('accepts a redirect to an HTTPS location', () => {
    assert({
      given: 'a 301 redirecting to an https:// location',
      should: 'report nothing',
      actual: httpsRedirectIssues(
        response(301, { location: 'https://offense-demo-staging.fly.dev/' }),
      ),
      expected: [],
    });
  });

  test('flags plaintext HTTP that answers instead of redirecting', () => {
    assert({
      given: 'a 200 on plaintext HTTP',
      should: 'report the status',
      actual: httpsRedirectIssues(response(200)),
      expected: ['plaintext HTTP answered 200 instead of redirecting'],
    });
  });

  test('flags a redirect to a non-HTTPS location', () => {
    assert({
      given: 'a redirect whose Location is not https',
      should: 'report it',
      actual: httpsRedirectIssues(
        response(301, { location: 'http://offense-demo-staging.fly.dev/' }),
      ),
      expected: [
        'redirect Location "http://offense-demo-staging.fly.dev/" is not HTTPS',
      ],
    });
  });
});

describe('corsIssues', () => {
  test('accepts no CORS headers at all', () => {
    assert({
      given: 'a response with no Access-Control-Allow-Origin',
      should: 'report nothing',
      actual: corsIssues(response(200), 'https://evil.example'),
      expected: [],
    });
  });

  test('flags a credentialed wildcard', () => {
    assert({
      given: 'ACAO: * with credentials allowed',
      should: 'report the wildcard-plus-credentials combination',
      actual: corsIssues(
        response(200, {
          'access-control-allow-origin': '*',
          'access-control-allow-credentials': 'true',
        }),
        'https://evil.example',
      ),
      expected: [
        'Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true',
      ],
    });
  });

  test('flags an ACAO that echoes an arbitrary cross-site Origin with credentials allowed', () => {
    assert({
      given:
        'ACAO reflecting the caller-supplied cross-site Origin, credentials allowed',
      should: 'report it',
      actual: corsIssues(
        response(200, {
          'access-control-allow-origin': 'https://evil.example',
          'access-control-allow-credentials': 'true',
        }),
        'https://evil.example',
      ),
      expected: [
        'Access-Control-Allow-Origin echoes an arbitrary cross-site Origin (https://evil.example) with credentials allowed',
      ],
    });
  });

  test('accepts an ACAO without credentials allowed', () => {
    assert({
      given: 'ACAO: * without Access-Control-Allow-Credentials',
      should: 'report nothing',
      actual: corsIssues(
        response(200, { 'access-control-allow-origin': '*' }),
        'https://evil.example',
      ),
      expected: [],
    });
  });
});

describe('noSharedCacheIssues', () => {
  test('accepts no-store', () => {
    assert({
      given: 'Cache-Control: no-store',
      should: 'report nothing',
      actual: noSharedCacheIssues(
        response(200, { 'cache-control': 'no-store' }),
      ),
      expected: [],
    });
  });

  test('flags a missing no-store', () => {
    assert({
      given: 'no Cache-Control header',
      should: 'report the absence',
      actual: noSharedCacheIssues(response(200)),
      expected: ['Cache-Control "(absent)" lacks no-store'],
    });
  });

  test('flags shared caching directives beside no-store', () => {
    assert({
      given: 'Cache-Control: no-store, public',
      should: 'report the shared-cache directive',
      actual: noSharedCacheIssues(
        response(200, { 'cache-control': 'no-store, public' }),
      ),
      expected: ['Cache-Control "no-store, public" permits shared caching'],
    });
  });
});

describe('originEnforcementIssues', () => {
  test('accepts 403', () => {
    assert({
      given: 'a cross-origin state change answered 403',
      should: 'report nothing',
      actual: originEnforcementIssues(response(403)),
      expected: [],
    });
  });

  test('flags a 200 that processed the cross-origin request', () => {
    assert({
      given: 'a cross-origin state change answered 200',
      should: 'report it',
      actual: originEnforcementIssues(response(200)),
      expected: ['cross-origin POST answered 200 instead of 401/403'],
    });
  });
});

describe('clientIpTrustIssues', () => {
  test('accepts one identity across forged-header requests', () => {
    assert({
      given: 'the same clientIdHash for every request, forged headers included',
      should: 'report nothing',
      actual: clientIpTrustIssues(['abc', 'abc', 'abc', 'abc', 'abc']),
      expected: [],
    });
  });

  test('flags distinct identities as a caller choosing its own', () => {
    assert({
      given: 'two different clientIdHash values across the same requests',
      should: 'report the trust failure',
      actual: clientIpTrustIssues(['abc', 'abc', 'def']),
      expected: [
        '2 distinct clientIdHash values across forged-header requests; the ingress trusted a caller-supplied header',
      ],
    });
  });
});

describe('cookieAttributeIssues', () => {
  test('accepts an HttpOnly, Secure, SameSite, host-only, path-scoped cookie', () => {
    assert({
      given:
        '__Secure-better-auth.session_token=x; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax',
      should: 'report nothing',
      actual: cookieAttributeIssues(
        '__Secure-better-auth.session_token=x; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax',
      ),
      expected: [],
    });
  });

  test('names every missing or wrong attribute', () => {
    assert({
      given:
        'a cookie missing HttpOnly, Secure and SameSite, and scoped by Domain',
      should: 'report each problem',
      actual: cookieAttributeIssues('session=x; Domain=fly.dev'),
      expected: [
        'session: missing HttpOnly',
        'session: missing Secure',
        'session: missing SameSite',
        'session: sets Domain (should be host-only)',
        'session: missing Path',
      ],
    });
  });
});

describe('secretLeakIssues', () => {
  test('accepts log lines with no secret-bearing pattern', () => {
    assert({
      given: 'structured log lines that carry only a clientIdHash',
      should: 'report nothing',
      actual: secretLeakIssues([
        '{"event":"http.request.completed","clientIdHash":"abc"}',
        '{"event":"server.start","port":8080}',
      ]),
      expected: [],
    });
  });

  test('flags a credentialed connection string', () => {
    assert({
      given: 'a line carrying a postgres URL with a password',
      should: 'report the leak',
      actual: secretLeakIssues([
        'dial postgres://offense_demo_web:S3CRET@host:5432/db failed',
      ]),
      expected: ['1 log line(s) carry a secret-bearing pattern'],
    });
  });

  test('flags a secret env var name appearing in a log line', () => {
    assert({
      given: 'a line naming MIGRATION_DATABASE_URL',
      should: 'report the leak',
      actual: secretLeakIssues([
        'Invalid server configuration: MIGRATION_DATABASE_URL',
      ]),
      expected: ['1 log line(s) carry a secret-bearing pattern'],
    });
  });
});
