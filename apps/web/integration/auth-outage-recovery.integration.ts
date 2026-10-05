import { afterAll, setDefaultTimeout } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { systemClock, systemId } from '@offense-demo/clock';
import { requireTestServices } from '@offense-demo/config';
import { createFaultedApp } from './fault-proxy';
import { createTestApp, linkFrom, tokenOf, withSql } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import type { Fetch } from '../src/features/auth/mail';
import { createApp } from '../src/server/app';
import { createRoutes } from '../src/server/routes';

/**
 * AUTH-6.7 AC3: instance restart is already proven by
 * `auth-migration-restart.integration.ts` (a live session, passkey and
 * username all survive a real application restart against the same
 * PostgreSQL). This suite covers the leaf's remaining three dependency
 * failures — a genuine, recoverable database outage, a genuine, recoverable
 * Redis outage and a genuine Resend delivery timeout — each interrupted and
 * then restored, proving the mounted routes fail safely (no duplicate
 * identity, no unauthorized access) while the dependency is down and serve
 * correctly again once it returns. The shared local stack itself is never
 * stopped (ADR 0034): `fault-proxy.ts` is a controllable relay this
 * checkout owns in front of the real services.
 */
requireTestServices(process.env);
setupRitewayBun();
setDefaultTimeout(30_000);

const testApp = createTestApp();

const countUsers = (email: string) =>
  withSql(
    (sql) => sql`SELECT count(*)::int AS n FROM users WHERE email = ${email}`,
  ).then((rows) => Number(rows[0]?.n ?? 0));

describe('AUTH-6.7 AC3 database outage and recovery', () => {
  test('a paused database fails link issuance safely and a resumed one recovers with no duplicate identity', async () => {
    const { routes, proxy: dbProxy } = createFaultedApp(
      testApp,
      'DATABASE_URL',
    );

    const email = testApp.freshEmail();
    const magicLink = () =>
      routes.auth.POST(
        testApp.jsonPost('/api/auth/sign-in/magic-link', { email }),
      );

    const baseline = await magicLink();

    dbProxy.pause();
    const duringOutage = await magicLink();
    const countDuringOutage = await countUsers(email);

    dbProxy.resume();
    const link = linkFrom(testApp.mailbox.mails.at(-1)!);
    const redeemed = await routes.confirm.POST(
      testApp.formPost({ token: tokenOf(link), callbackURL: '/app' }),
    );
    const countAfterRecovery = await countUsers(email);

    assert({
      given:
        'a magic-link request while the database is reachable, one while it is paused, then one after it resumes',
      should:
        'admit the first, fail the paused one safely with no user row created, and let the resumed request complete sign-up exactly once',
      actual: {
        baselineStatus: baseline.status,
        outageStatus: duringOutage.status,
        outageCode: ((await duringOutage.json()) as { code?: string }).code,
        countDuringOutage,
        redeemedHasCookie: redeemed.headers.getSetCookie().length > 0,
        countAfterRecovery,
      },
      expected: {
        baselineStatus: 200,
        outageStatus: 503,
        // The request-time suppression check is the first database read on
        // this route: its outage answers the typed retryable 503.
        outageCode: 'AUTH_TEMPORARILY_UNAVAILABLE',
        countDuringOutage: 0,
        redeemedHasCookie: true,
        countAfterRecovery: 1,
      },
    });
  });
});

describe('AUTH-6.7 AC3 Redis outage and recovery', () => {
  test('a paused limiter fails every request safely, including a valid session read, and a resumed one recovers', async () => {
    const { routes, proxy: redisProxy } = createFaultedApp(
      testApp,
      'REDIS_URL',
    );

    // A real session, established before the outage, over the shared
    // database (unaffected: only Redis, the limiter, is behind this proxy).
    const email = testApp.freshEmail();
    await routes.auth.POST(
      testApp.jsonPost('/api/auth/sign-in/magic-link', { email }),
    );
    const link = linkFrom(testApp.mailbox.mails.at(-1)!);
    const signedIn = await routes.confirm.POST(
      testApp.formPost({ token: tokenOf(link), callbackURL: '/app' }),
    );
    const cookie = signedIn.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0])
      .join('; ');

    redisProxy.pause();
    const outageSessionRead = await routes.auth.GET(
      new Request(`${testApp.origin}/api/auth/get-session`, {
        headers: { cookie, [CLIENT_IP_HEADER]: testApp.newClient() },
      }),
    );

    redisProxy.resume();
    const recoveredSessionRead = await routes.auth.GET(
      new Request(`${testApp.origin}/api/auth/get-session`, {
        headers: { cookie, [CLIENT_IP_HEADER]: testApp.newClient() },
      }),
    );

    assert({
      given:
        'an authenticated session read while the rate limiter is unreachable, then again after it recovers',
      should:
        'answer 503 while paused (never an unlimited or falsely authenticated bypass) and 200 once resumed',
      actual: {
        outageStatus: outageSessionRead.status,
        recoveredStatus: recoveredSessionRead.status,
      },
      expected: { outageStatus: 503, recoveredStatus: 200 },
    });
  });
});

describe('AUTH-6.7 AC3 Resend timeout and recovery', () => {
  test('a hung provider call times out safely with no duplicate token, and the next request recovers', async () => {
    // Hangs on its first call until the sender's real 10 s deadline aborts
    // it (matching the production Resend transport's fixed timeout, never
    // lowered for this test), then behaves as the suite's normal mailbox for
    // every later call, standing in for the provider recovering.
    let first = true;
    const onceHungThenRecovers: Fetch = (input, init) => {
      if (!first) return testApp.mailbox.fetch(input, init);
      first = false;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    };
    const app = createApp({
      env: testApp.env,
      fetch: onceHungThenRecovers,
      clock: systemClock,
      ids: systemId,
    });
    const routes = createRoutes(app);
    afterAll(() => app.close());

    const email = testApp.freshEmail();
    const magicLink = () =>
      routes.auth.POST(
        testApp.jsonPost('/api/auth/sign-in/magic-link', { email }),
      );

    const timedOut = await magicLink();
    const tokensAfterTimeout = await withSql(
      (sql) =>
        sql`SELECT count(*)::int AS n FROM verification WHERE strpos(value, ${email}) > 0`,
    ).then((rows) => Number(rows[0]?.n ?? 0));

    const before = testApp.mailbox.mails.length;
    const recovered = await magicLink();
    const mailedAfterRecovery = testApp.mailbox.mails.length - before;

    assert({
      given:
        "a magic-link request whose Resend call hangs past the sender's real timeout, then a following request",
      should:
        'answer a safe retryable error with at most one stored token, and let the following request deliver normally',
      actual: {
        timedOutStatus: timedOut.status,
        timedOutOk: timedOut.ok,
        tokensAfterTimeout,
        recoveredStatus: recovered.status,
        mailedAfterRecovery,
      },
      expected: {
        timedOutStatus: 503,
        timedOutOk: false,
        tokensAfterTimeout: 1,
        recoveredStatus: 200,
        mailedAfterRecovery: 1,
      },
    });
  }, 20_000);
});
