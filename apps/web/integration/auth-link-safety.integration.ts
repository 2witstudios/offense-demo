import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createFlows } from './auth-mounted-flows';
import { cookieHeader, counts } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const flows = createFlows();
const { authRoute, confirmRoute, fresh, mailbox, redeem, startSignup } = flows;
const { newClient, jsonPost, formPost } = flows;

/** Everything this suite's app logged while `work` ran, serialized. */
async function recordingLogs(work: () => Promise<void>) {
  const { records } = await flows.testApp.recordLogs(work);
  return JSON.stringify(records);
}

describe('AUTH-3.2 / AUTH-3.5 origin and destination safety', () => {
  test('foreign, missing and malformed posts are rejected and leave the token unconsumed', async () => {
    const { email, token } = await startSignup();
    const foreign = await confirmRoute.POST(
      formPost(
        { token, callbackURL: '/app' },
        { origin: 'https://evil.example' },
      ),
    );
    const noOrigin = await confirmRoute.POST(
      new Request('http://localhost:3000/auth/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
    const authForeign = await authRoute.POST(
      jsonPost(
        '/api/auth/sign-in/magic-link',
        { email: fresh() },
        { origin: 'https://evil.example' },
      ),
    );
    const badCallback = await authRoute.POST(
      jsonPost('/api/auth/sign-in/magic-link', {
        email: fresh(),
        callbackURL: 'https://evil.example/steal',
      }),
    );
    const multipart = await confirmRoute.POST(
      new Request('http://localhost:3000/auth/confirm', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'multipart/form-data; boundary=x',
        },
        body: '--x--',
      }),
    );
    assert({
      given:
        'cross-origin, origin-less, external-callback and wrong-type posts',
      should: 'refuse each (403 ×4, 400) and leave the token unconsumed',
      actual: {
        statuses: [foreign, noOrigin, authForeign, badCallback, multipart].map(
          (response) => response.status,
        ),
        cookies: [foreign, noOrigin, authForeign].map(
          (response) => response.headers.getSetCookie().length,
        ),
        counts: await counts(email),
      },
      expected: {
        statuses: [403, 403, 403, 403, 400],
        cookies: [0, 0, 0],
        counts: { users: 0, sessions: 0, verifications: 1, passkeys: 0 },
      },
    });
  });

  test('malformed requests are refused as client errors without cookies, tokens or server faults', async () => {
    const origin = 'http://localhost:3000';
    const post = (body: string, contentType: string) =>
      authRoute.POST(
        new Request(`${origin}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': contentType,
            'x-offense-demo-client-ip': newClient(),
          },
          body,
        }),
      );
    const responses = await Promise.all([
      post('{"email":', 'application/json'),
      post('{"email":123}', 'application/json'),
      post('{"email":"not-an-email"}', 'application/json'),
      post('email=a%40b.co', 'application/x-www-form-urlencoded'),
      post('{}', 'application/json'),
    ]);
    assert({
      given:
        'truncated JSON, a wrong type, a bad address, a form body and an empty object',
      should: 'answer 4xx for each, set no cookie and send no mail',
      actual: {
        statuses: responses.map((response) => response.status),
        cookies: responses.map(
          (response) => response.headers.getSetCookie().length,
        ),
        sent: mailbox.mails.filter((mail) => mail.to === 'a@b.co').length,
      },
      expected: {
        statuses: [400, 400, 400, 415, 400],
        cookies: [0, 0, 0, 0, 0],
        sent: 0,
      },
    });
  });

  test('an external destination in the confirmation POST never becomes the redirect', async () => {
    const { token } = await startSignup();
    const external = await redeem(token, {
      callbackURL: 'https://evil.example/steal',
      newUserCallbackURL: '//evil.example',
    });
    assert({
      given: 'a confirm POST whose destinations are external',
      should: 'sign in but land on a safe local default',
      actual: external.headers.get('location'),
      expected: '/onboarding/username',
    });
  });
});

describe('AUTH-3.3 delivery failure and log safety', () => {
  test('provider failure yields a generic retryable error and never echoes the link', async () => {
    const email = fresh();
    mailbox.failNext('transient', 'transient');
    const failed = await authRoute.POST(
      jsonPost('/api/auth/sign-in/magic-link', { email }),
    );
    const text = await failed.text();
    mailbox.failNext('permanent');
    const rejected = await authRoute.POST(
      jsonPost('/api/auth/sign-in/magic-link', { email }),
    );
    assert({
      given: 'the provider failing transiently twice, then permanently',
      should:
        'answer 503 with a fixed retryable body, no provider or recipient detail, and send nothing',
      actual: {
        statuses: [failed.status, rejected.status],
        code: (JSON.parse(text) as { code?: string }).code,
        retryAfter: failed.headers.get('retry-after'),
        leaks: ['upstream boom', email, 'resend', 'token='].filter((needle) =>
          text.toLowerCase().includes(needle.toLowerCase()),
        ),
        sent: mailbox.mails.filter((mail) => mail.to === email).length,
      },
      expected: {
        statuses: [503, 503],
        code: 'EMAIL_DELIVERY_FAILED',
        retryAfter: '5',
        leaks: [],
        sent: 0,
      },
    });
  });

  test('failed delivery logs contain no link, address or provider text', async () => {
    const email = fresh();
    const serialized = await recordingLogs(async () => {
      mailbox.failNext('transient', 'transient');
      await authRoute.POST(jsonPost('/api/auth/sign-in/magic-link', { email }));
    });
    assert({
      given: 'structured logs from a failed delivery',
      should: 'record the failure without secrets',
      actual: ['token=', email, 'upstream boom', 'auth/confirm'].filter(
        (needle) => serialized.includes(needle),
      ),
      expected: [],
    });
  });

  test('a full sign-in logs completion without URLs, tokens, cookies or addresses', async () => {
    let secrets: string[] = [];
    let email = '';
    const serialized = await recordingLogs(async () => {
      const signup = await startSignup();
      email = signup.email;
      const confirmed = await redeem(signup.token);
      secrets = [
        signup.token,
        signup.email,
        cookieHeader(confirmed).split('=')[1] ?? '',
        'auth/confirm',
        'magic-link',
      ];
    });
    assert({
      given: 'structured logs from a request and redemption',
      should: 'record completion events yet contain no credential material',
      actual: {
        logged: serialized.length > 2,
        leaks: secrets.filter(
          (needle) => needle.length > 0 && serialized.includes(needle),
        ),
        email: email.length > 0,
      },
      expected: { logged: true, leaks: [], email: true },
    });
  });
});

describe('AUTH-3.1 no password authentication', () => {
  test('password, reset and delete surfaces are refused outright by the mounted handler', async () => {
    const email = fresh();
    const attempts = [
      [
        '/api/auth/sign-up/email',
        { email, password: 'Sup3rSecret!!', name: 'x' },
      ],
      ['/api/auth/sign-in/email', { email, password: 'Sup3rSecret!!' }],
      ['/api/auth/request-password-reset', { email }],
      ['/api/auth/forget-password', { email }],
      [
        '/api/auth/reset-password',
        { newPassword: 'Sup3rSecret!!', token: 'x' },
      ],
      ['/api/auth/change-password', { newPassword: 'a', currentPassword: 'b' }],
      ['/api/auth/set-password', { newPassword: 'Sup3rSecret!!' }],
      ['/api/auth/delete-user', {}],
    ] as const;
    const responses = await Promise.all(
      attempts.map(([path, body]) => authRoute.POST(jsonPost(path, body))),
    );
    assert({
      given: 'direct calls to every password, reset and delete endpoint',
      should: 'refuse all with 404, issue no cookie and create no user',
      actual: {
        statuses: responses.map((response) => response.status),
        cookies: responses.map(
          (response) => response.headers.getSetCookie().length,
        ),
        counts: await counts(email),
      },
      expected: {
        statuses: Array(attempts.length).fill(404),
        cookies: Array(attempts.length).fill(0),
        counts: { users: 0, sessions: 0, verifications: 0, passkeys: 0 },
      },
    });
  });
});
