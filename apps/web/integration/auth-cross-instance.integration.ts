import { afterAll } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { systemClock, systemId } from '@offense-demo/clock';
import { requireTestServices } from '@offense-demo/config';
import {
  cookieHeader,
  createTestApp,
  linkFrom,
  tokenOf,
  withSql,
} from './fixtures';
import { uniqueName } from './auth-account-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { createApp } from '../src/server/app';
import { createRoutes } from '../src/server/routes';
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createSoftwareCredential,
} from './webauthn-authenticator';

/**
 * AUTH-6.7 AC1: two application instances over the same PostgreSQL database
 * and the same Redis namespace, with no sticky session or in-process state
 * bridging them. `instanceA` is the suite's own app (`testApp`); `instanceB`
 * is a second, independently composed `createApp` over the identical
 * environment (same `DATABASE_URL`, `REDIS_NAMESPACE`), exactly as a second
 * deployed process would be. Rate limits are already proven shared across
 * two instances in `auth-rate-limit.integration.ts` ("two application
 * instances share one atomic counter"); this suite covers the leaf's other
 * four surfaces: sessions, passkey challenges, one-time token consumption
 * and username uniqueness.
 */
requireTestServices(process.env);
setupRitewayBun();

const testApp = createTestApp();
const rpID = 'localhost';

const instanceB = createApp({
  env: testApp.env,
  fetch: testApp.mailbox.fetch,
  clock: systemClock,
  ids: systemId,
});
const routesB = createRoutes(instanceB);
afterAll(() => instanceB.close());

const routesOf = (instance: 'a' | 'b') =>
  instance === 'a' ? testApp.routes : routesB;

const requestLink = async (email: string) => {
  const before = testApp.mailbox.mails.length;
  const response = await testApp.routes.auth.POST(
    testApp.jsonPost('/api/auth/sign-in/magic-link', { email }),
  );
  const mail = testApp.mailbox.mails[before];
  if (!mail)
    throw new Error(`No mail captured for ${email}: HTTP ${response.status}`);
  return tokenOf(linkFrom(mail));
};

const redeemOn = (instance: 'a' | 'b', token: string) =>
  routesOf(instance).confirm.POST(
    testApp.formPost({ token, callbackURL: '/app' }),
  );

const sessionOn = (instance: 'a' | 'b', cookie: string) =>
  routesOf(instance).auth.GET(
    new Request(`${testApp.origin}/api/auth/get-session`, {
      headers: { cookie, [CLIENT_IP_HEADER]: testApp.newClient() },
    }),
  );

const signUpOn = async (instance: 'a' | 'b') => {
  const email = testApp.freshEmail();
  const token = await requestLink(email);
  const response = await redeemOn(instance, token);
  await testApp.recordAccountIds();
  return { email, cookie: cookieHeader(response) };
};

const authRouteGet = (instance: 'a' | 'b', path: string, cookie?: string) =>
  routesOf(instance).auth.GET(
    new Request(`${testApp.origin}${path}`, {
      headers: {
        ...(cookie ? { cookie } : {}),
        [CLIENT_IP_HEADER]: testApp.newClient(),
      },
    }),
  );

const authRoutePost = (
  instance: 'a' | 'b',
  path: string,
  body: unknown,
  cookie?: string,
) =>
  routesOf(instance).auth.POST(
    new Request(`${testApp.origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: testApp.origin,
        ...(cookie ? { cookie } : {}),
        [CLIENT_IP_HEADER]: testApp.newClient(),
      },
      body: JSON.stringify(body),
    }),
  );

const mergeCookies = (...parts: readonly string[]) =>
  parts.filter((part) => part !== '').join('; ');

describe('AUTH-6.7 AC1 cross-instance sessions', () => {
  test('a session created through instance A is authenticated through instance B', async () => {
    const { cookie } = await signUpOn('a');
    const onA = await sessionOn('a', cookie);
    const onB = await sessionOn('b', cookie);
    assert({
      given: 'a magic-link sign-in redeemed on instance A',
      should:
        'answer 200 with the same session on both instance A and instance B',
      actual: {
        statusA: onA.status,
        statusB: onB.status,
        sameUser:
          ((await onA.clone().json()) as { user: { id: string } }).user.id ===
          ((await onB.clone().json()) as { user: { id: string } }).user.id,
      },
      expected: { statusA: 200, statusB: 200, sameUser: true },
    });
  });
});

describe('AUTH-6.7 AC1 cross-instance passkey challenges', () => {
  test('a registration challenge issued by instance A is completed by instance B', async (): Promise<void> => {
    const { email, cookie } = await signUpOn('a');
    const optionsResponse = await authRouteGet(
      'a',
      '/api/auth/passkey/generate-register-options',
      cookie,
    );
    const options = (await optionsResponse.json()) as { challenge: string };
    const credential = await createSoftwareCredential();
    const registration = buildRegistrationResponse({
      credential,
      challenge: options.challenge,
      origin: testApp.origin,
      rpID,
    });
    const verifyResponse = await authRoutePost(
      'b',
      '/api/auth/passkey/verify-registration',
      { response: registration, name: 'Cross-instance key' },
      mergeCookies(cookie, cookieHeader(optionsResponse)),
    );
    const stored = await withSql(
      (sql) =>
        sql`SELECT count(*)::int AS n FROM passkey p JOIN users u ON u.id = p.user_id WHERE u.email = ${email}`,
    );
    assert({
      given:
        'registration options requested on instance A, verified on instance B',
      should: 'succeed and persist exactly one credential',
      actual: { status: verifyResponse.status, stored: stored[0]?.n },
      expected: { status: 200, stored: 1 },
    });
  });

  test('an authentication challenge issued by instance B is completed by instance A', async () => {
    const { cookie } = await signUpOn('a');
    const enrollOptions = await authRouteGet(
      'a',
      '/api/auth/passkey/generate-register-options',
      cookie,
    );
    const enrollBody = (await enrollOptions.json()) as { challenge: string };
    const credential = await createSoftwareCredential();
    const registration = buildRegistrationResponse({
      credential,
      challenge: enrollBody.challenge,
      origin: testApp.origin,
      rpID,
    });
    await authRoutePost(
      'a',
      '/api/auth/passkey/verify-registration',
      { response: registration, name: 'Roaming key' },
      mergeCookies(cookie, cookieHeader(enrollOptions)),
    );

    const authOptions = await authRouteGet(
      'b',
      '/api/auth/passkey/generate-authenticate-options',
    );
    const authBody = (await authOptions.json()) as { challenge: string };
    const assertion = await buildAuthenticationResponse({
      credential,
      challenge: authBody.challenge,
      origin: testApp.origin,
      rpID,
    });
    const verifyResponse = await authRoutePost(
      'a',
      '/api/auth/passkey/verify-authentication',
      { response: assertion },
      cookieHeader(authOptions),
    );
    assert({
      given:
        'authentication options requested on instance B, verified on instance A',
      should: 'sign the account in with a fresh session cookie',
      actual: {
        status: verifyResponse.status,
        hasSessionCookie: verifyResponse.headers.getSetCookie().length > 0,
      },
      expected: { status: 200, hasSessionCookie: true },
    });
  });
});

describe('AUTH-6.7 AC1 cross-instance one-time token consumption', () => {
  test('a token requested through instance A is redeemed once when instance A and instance B race for it', async () => {
    const email = testApp.freshEmail();
    const token = await requestLink(email);
    const [onA, onB] = await Promise.all([
      redeemOn('a', token),
      redeemOn('b', token),
    ]);
    const winners = [onA, onB].filter(
      (response) => response.headers.getSetCookie().length > 0,
    );
    const rows = await withSql(
      (sql) => sql`SELECT count(*)::int AS n FROM users WHERE email = ${email}`,
    );
    assert({
      given: 'one magic-link token redeemed simultaneously on two instances',
      should:
        'authenticate exactly one of the two attempts and create exactly one account',
      actual: { winners: winners.length, accounts: rows[0]?.n },
      expected: { winners: 1, accounts: 1 },
    });
  });
});

describe('AUTH-6.7 AC1 cross-instance username uniqueness', () => {
  test('accounts claiming the same name split across two instances admit exactly one', async () => {
    // Sign-ups run sequentially: the shared mailbox matches mail by arrival
    // order, so concurrent requests would race for the same slot. Only the
    // claims below race.
    const contenders: Awaited<ReturnType<typeof signUpOn>>[] = [];
    for (const instance of ['a', 'b', 'a', 'b'] as const)
      contenders.push(await signUpOn(instance));
    const name = uniqueName();
    const responses = await Promise.all(
      contenders.map(({ cookie }, index) =>
        routesOf(index % 2 === 0 ? 'a' : 'b').username.POST(
          testApp.jsonPost(
            '/api/account/username',
            { username: name },
            {
              cookie,
            },
          ),
        ),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    const owners = await withSql(
      (sql) =>
        sql`SELECT count(*)::int AS n FROM users WHERE lower(username) = ${name}`,
    );
    assert({
      given:
        'four verified accounts claiming one name, split across two instances',
      should: 'grant exactly one claim and refuse the rest with 409',
      actual: { statuses, owners: owners[0]?.n },
      expected: { statuses: [201, 409, 409, 409], owners: 1 },
    });
  });
});
