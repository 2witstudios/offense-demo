import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { silentLogger } from '../../server/test-loggers.test-support';
import { createConfirmHandlers } from './confirm';

setupRitewayBun();

const token = 'a'.repeat(32);

/** Better Auth answering a verify: an absolute redirect on the public origin. */
const handlers = (location: string) =>
  createConfirmHandlers({
    logger: silentLogger,
    auth: () => ({
      config: { PUBLIC_APP_URL: 'https://offense-demo.invalid' },
      handler: async () =>
        new Response(null, {
          status: 302,
          headers: { location, 'set-cookie': 'session=value; Path=/' },
        }),
    }),
  });

const post = (headers: Record<string, string>) =>
  // The request as Next sees it behind a TLS terminator: plain HTTP.
  new Request('http://internal.invalid/auth/confirm', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams({ token, callbackURL: '/items' }).toString(),
  });

describe('confirm submit when the forwarded auth request fails', () => {
  const throwingHandlers = createConfirmHandlers({
    logger: silentLogger,
    auth: () => ({
      config: { PUBLIC_APP_URL: 'https://offense-demo.invalid' },
      handler: async () => {
        throw new Error('redis://secret-host unreachable');
      },
    }),
  });

  test('renders a retryable page instead of propagating the failure', async () => {
    const response = await throwingHandlers.POST(
      post({ origin: 'https://offense-demo.invalid' }),
    );
    const body = await response.text();
    assert({
      given: 'the composed auth handler throwing (a real outage)',
      should:
        'answer a safe 503 confirm page, retryable, with no internal detail',
      actual: {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        leaks: body.includes('redis://secret-host'),
      },
      expected: { status: 503, retryAfter: '5', leaks: false },
    });
  });
});

describe('confirm submit behind TLS termination', () => {
  test('keeps the destination when the target is on the public origin', async () => {
    const response = await handlers(
      'https://offense-demo.invalid/items?tab=open',
    ).POST(post({ origin: 'https://offense-demo.invalid' }));
    assert({
      given:
        'an absolute HTTPS redirect from the auth handler for a request the app sees as HTTP',
      should:
        'redirect to the same path and query and carry the session cookie',
      actual: [
        response.status,
        response.headers.get('location'),
        response.headers.getSetCookie(),
      ],
      expected: [303, '/items?tab=open', ['session=value; Path=/']],
    });
  });

  test('still refuses a foreign target', async () => {
    const response = await handlers('https://evil.example/steal').POST(
      post({ origin: 'https://offense-demo.invalid' }),
    );
    assert({
      given: 'a redirect to another origin',
      should: 'fall back to the signed-in home',
      actual: [response.status, response.headers.get('location')],
      expected: [303, '/app'],
    });
  });

  test('accepts the null origin a no-referrer form sends from the same origin', async () => {
    const same = await handlers('/items').POST(
      post({ origin: 'null', 'sec-fetch-site': 'same-origin' }),
    );
    const cross = await handlers('/items').POST(
      post({ origin: 'null', 'sec-fetch-site': 'cross-site' }),
    );
    assert({
      given: 'Origin null from same-origin and cross-site senders',
      should: 'redirect the first and refuse the second with 403',
      actual: [same.status, cross.status],
      expected: [303, 403],
    });
  });
});

describe('confirm destinations never return to sign-in, auth or api routes (ISSUE-167)', () => {
  test('forwards returnable destinations to the redemption, not auth or api routes', async () => {
    const forwarded: URL[] = [];
    const recording = createConfirmHandlers({
      logger: silentLogger,
      auth: () => ({
        config: { PUBLIC_APP_URL: 'https://offense-demo.invalid' },
        handler: async (request: Request) => {
          forwarded.push(new URL(request.url));
          return new Response(null, {
            status: 302,
            headers: {
              location: 'https://offense-demo.invalid/app',
              'set-cookie': 'session=value; Path=/',
            },
          });
        },
      }),
    });
    await recording.POST(
      new Request('https://offense-demo.invalid/auth/confirm', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://offense-demo.invalid',
        },
        body: new URLSearchParams({
          token,
          callbackURL: '/api/auth/sign-out',
          newUserCallbackURL: '/sign-in',
        }).toString(),
      }),
    );
    assert({
      given:
        'a submitted form whose destinations name an api route and the sign-in page',
      should:
        'forward the signed-in home and the username onboarding page to the redemption instead',
      actual: {
        callbackURL: forwarded[0]?.searchParams.get('callbackURL'),
        newUserCallbackURL:
          forwarded[0]?.searchParams.get('newUserCallbackURL'),
      },
      expected: {
        callbackURL: '/app',
        newUserCallbackURL: '/onboarding/username',
      },
    });
  });

  test('a same-origin success redirect to an api route lands on the signed-in home', async () => {
    const response = await handlers(
      'https://offense-demo.invalid/api/account/sessions',
    ).POST(post({ origin: 'https://offense-demo.invalid' }));
    assert({
      given: "a signed-in redirect to the public origin's own /api route",
      should: 'send the new session to the signed-in home instead',
      actual: [response.status, response.headers.get('location')],
      expected: [303, '/app'],
    });
  });
});
