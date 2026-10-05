import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createAppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import { createAuthRouteHandlers, preserve } from './handlers';

setupRitewayBun();

const recorded: unknown[] = [];
const recorder: Logger = {
  log: (...entry) => recorded.push(entry),
  child: () => recorder,
};

const config = { PUBLIC_APP_URL: 'http://localhost:3000' };
const post = (headers: Record<string, string> = {}) =>
  new Request(
    'http://localhost:3000/api/auth/sign-in/magic-link?token=SECRET',
    {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', ...headers },
      body: '{}',
    },
  );

describe('preserve', () => {
  test('keeps status, redirect target, body bytes and every Set-Cookie header', async () => {
    const headers = new Headers({ location: '/app' });
    headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
    headers.append('set-cookie', 'b=2; Path=/; Secure');
    const copy = preserve(
      new Response('{"ok":true}', { status: 302, headers }),
    );
    assert({
      given: 'a redirect carrying two cookies and a body',
      should: 'return them untouched in a mutable response',
      actual: {
        status: copy.status,
        location: copy.headers.get('location'),
        cookies: copy.headers.getSetCookie(),
        body: await copy.text(),
      },
      expected: {
        status: 302,
        location: '/app',
        cookies: ['a=1; Path=/; HttpOnly', 'b=2; Path=/; Secure'],
        body: '{"ok":true}',
      },
    });
  });

  test('advertises the standard Retry-After beside X-Retry-After', () => {
    const copy = preserve(
      new Response('{}', { status: 429, headers: { 'x-retry-after': '17' } }),
    );
    assert({
      given: 'a Better Auth 429',
      should: 'add Retry-After with the same seconds',
      actual: [
        copy.headers.get('retry-after'),
        copy.headers.get('x-retry-after'),
      ],
      expected: ['17', '17'],
    });
  });
});

describe('createAuthRouteHandlers', () => {
  test('delegates GET and POST, adds correlation and no-store, keeps cookies and never logs the URL', async () => {
    recorded.length = 0;
    const handlers = createAuthRouteHandlers(
      () => ({
        config,
        handler: async () => {
          const headers = new Headers({ 'content-type': 'application/json' });
          headers.append('set-cookie', 'session=abc; HttpOnly');
          headers.append('set-cookie', 'other=def');
          return new Response('{"status":true}', { headers });
        },
      }),
      recorder,
    );
    const response = await handlers.POST(post());
    assert({
      given: 'a delegated auth response with two cookies',
      should:
        'add x-request-id and no-store yet preserve body and cookies without logging the query',
      actual: {
        status: response.status,
        body: await response.text(),
        cookies: response.headers.getSetCookie().length,
        noStore: response.headers.get('cache-control'),
        requestId: Boolean(response.headers.get('x-request-id')),
        logLeaksToken: JSON.stringify(recorded).includes('SECRET'),
      },
      expected: {
        status: 200,
        body: '{"status":true}',
        cookies: 2,
        noStore: 'no-store',
        requestId: true,
        logLeaksToken: false,
      },
    });
  });

  test('rejects state-changing calls from foreign or absent origins before delegating', async () => {
    let delegated = 0;
    const handlers = createAuthRouteHandlers(
      () => ({
        config,
        handler: async () => {
          delegated += 1;
          return new Response('{}');
        },
      }),
      recorder,
    );
    const foreign = await handlers.POST(
      post({ origin: 'https://evil.example' }),
    );
    const absent = await handlers.POST(
      new Request('http://localhost:3000/api/auth/sign-out', {
        method: 'POST',
      }),
    );
    assert({
      given: 'POSTs from https://evil.example and with no Origin',
      should: 'answer 403 without reaching Better Auth',
      actual: [foreign.status, absent.status, delegated],
      expected: [403, 403, 0],
    });
  });

  test('logs a lifecycle event for a known mounted path, never for an unknown one or a failure', async () => {
    const events = () => recorded.map((entry) => (entry as unknown[])[0]);
    const call = async (path: string, status = 200) => {
      recorded.length = 0;
      const handlers = createAuthRouteHandlers(
        () => ({
          config,
          handler: async () => new Response('{}', { status }),
        }),
        recorder,
      );
      await handlers.POST(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: 'POST',
          headers: { origin: 'http://localhost:3000' },
          body: '{}',
        }),
      );
    };
    await call('/passkey/verify-registration');
    const enrolled = events();
    await call('/passkey/verify-registration', 400);
    const failedEnroll = events();
    await call('/passkey/generate-register-options');
    const unmapped = events();
    assert({
      given: 'a successful call to a mapped lifecycle path',
      should: 'log the specific auth lifecycle event',
      actual: enrolled,
      expected: ['auth.passkey.enrolled', 'http.request.completed'],
    });
    assert({
      given: 'a failing call to a mapped lifecycle path',
      should: 'log no lifecycle event',
      actual: failedEnroll,
      expected: ['http.request.completed'],
    });
    assert({
      given: 'a successful call to an unmapped path',
      should: 'log no lifecycle event',
      actual: unmapped,
      expected: ['http.request.completed'],
    });
  });

  test('refuses a direct GET or POST to /magic-link/verify or /email-change/verify with 404, never reaching Better Auth', async () => {
    let delegated = 0;
    const handlers = createAuthRouteHandlers(
      () => ({
        config,
        // If the guard is ever removed, this fake handler answers 200 with a
        // session cookie for every path, so the negative control below fails.
        handler: async () => {
          delegated += 1;
          return new Response('{"status":true}', {
            headers: { 'set-cookie': 'better-auth.session_token=x; Path=/' },
          });
        },
      }),
      recorder,
    );
    const get = (path: string) =>
      new Request(`http://localhost:3000/api/auth${path}?token=T`);
    const results = await Promise.all([
      handlers.GET(get('/magic-link/verify')),
      handlers.GET(get('/email-change/verify')),
      handlers.POST(get('/magic-link/verify')),
      handlers.POST(get('/email-change/verify')),
    ]);
    assert({
      given: 'a direct request to either emailed-link redemption endpoint',
      should: 'answer 404 with no cookie and never call Better Auth',
      actual: {
        statuses: results.map((response) => response.status),
        cookies: results.map(
          (response) => response.headers.getSetCookie().length,
        ),
        delegated,
      },
      expected: {
        statuses: [404, 404, 404, 404],
        cookies: [0, 0, 0, 0],
        delegated: 0,
      },
    });
  });

  test('maps every thrown failure to a safe, retryable 503', async () => {
    const outage = createAuthRouteHandlers(
      () => ({
        config,
        handler: async () => {
          throw createAppError(
            'INFRASTRUCTURE',
            undefined,
            new Error('redis://secret-host'),
          );
        },
      }),
      recorder,
    );
    const crash = createAuthRouteHandlers(
      () => ({
        config,
        handler: async () => {
          throw new Error('SELECT * FROM users WHERE token=abc');
        },
      }),
      recorder,
    );
    const a = await outage.POST(post());
    const b = await crash.POST(post());
    const texts = JSON.stringify([
      await a.clone().json(),
      await b.clone().json(),
    ]);
    assert({
      given: 'a limiter outage and an unexpected exception',
      should: 'return 503 with Retry-After for both, exposing no internals',
      actual: {
        statuses: [a.status, b.status],
        retryAfter: a.headers.get('retry-after'),
        leaks: ['redis://', 'SELECT', 'token=abc'].filter((needle) =>
          texts.includes(needle),
        ),
      },
      expected: { statuses: [503, 503], retryAfter: '5', leaks: [] },
    });
  });
});
