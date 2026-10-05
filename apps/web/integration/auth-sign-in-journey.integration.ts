import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createAccountFlows,
  uniqueName,
  usernameOf,
} from './auth-account-helpers';
import { counts, tokenOf, withSql } from './fixtures';
import { decideAccess } from '../src/features/access/decision';
import { sessionRefreshDue } from '../src/features/auth/session-policy';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const { flows, identifyAs, sessionAs, signUp, claim } = createAccountFlows();
const { requestLink, redeem, session, newClient } = flows;
const { redisKeys } = flows.testApp;

describe('AUTH-4.4 / 4.2 sign-in loop through the real handlers', () => {
  test('request → emailed link → confirm → durable session → username → participant access', async () => {
    const { email, response, cookie } = await signUp();
    const sessionRows = (await counts(email)).sessions;
    const provisional = await identifyAs(cookie);
    const beforeAccess = decideAccess({
      identity: provisional,
      path: '/app',
      requirement: 'participant',
    });
    const name = uniqueName();
    const claimed = await claim(cookie, { username: name.toUpperCase() });
    const member = await identifyAs(cookie);
    assert({
      given:
        'a new address that requests a link and redeems it at /auth/confirm',
      should:
        'land on onboarding with a durable session, be provisional, claim a username, then be a member',
      actual: {
        redirect: [response.status, response.headers.get('location')],
        sessionRows,
        provisional: provisional.state,
        provisionalPrincipal: provisional.principal.kind,
        beforeAccess,
        claim: [claimed.status, await claimed.json()],
        member: member.state === 'member' ? member.username : member.state,
        memberPrincipal: member.principal.kind,
        afterAccess: decideAccess({
          identity: member,
          path: '/app',
          requirement: 'participant',
        }),
        stored: await usernameOf(email),
      },
      expected: {
        redirect: [303, '/onboarding/username?next=/app'],
        sessionRows: 1,
        provisional: 'provisional',
        provisionalPrincipal: 'user',
        beforeAccess: {
          kind: 'redirect',
          to: '/onboarding/username?next=%2Fapp',
        },
        claim: [201, { username: name }],
        member: name,
        memberPrincipal: 'user',
        afterAccess: { kind: 'allow' },
        stored: name,
      },
    });
  });

  test('replaying a redeemed link is rejected and mints no session', async () => {
    const { email, token } = await signUp();
    const replay = await redeem(token);
    const sessions = (await counts(email)).sessions;
    assert({
      given: 'the same emailed link redeemed a second time',
      should:
        'set no cookie, create no second session and redirect to the expired view',
      actual: {
        setsCookie: replay.headers.getSetCookie().length,
        sessions,
        redirect: [replay.status, replay.headers.get('location')],
      },
      expected: {
        setsCookie: 0,
        sessions: 1,
        redirect: [303, '/auth/confirm?error=INVALID_TOKEN'],
      },
    });
  });

  test('an unknown or forged cookie resolves anonymous', async () => {
    const forged = await identifyAs('better-auth.session_token=forged.value');
    assert({
      given: 'a cookie that names no durable session',
      should: 'resolve anonymous and be sent to sign-in',
      actual: [
        forged.state,
        decideAccess({
          identity: forged,
          path: '/play',
          requirement: 'participant',
        }),
      ],
      expected: [
        'anonymous',
        { kind: 'redirect', to: '/sign-in?next=%2Fplay' },
      ],
    });
  });

  test('a revoked session is anonymous on the very next check', async () => {
    const { email, cookie } = await signUp();
    await claim(cookie, { username: uniqueName() });
    const before = (await identifyAs(cookie)).state;
    await withSql(
      (sql) =>
        sql`DELETE FROM session WHERE user_id = (SELECT id FROM users WHERE email = ${email})`,
    );
    assert({
      given: 'a member whose session row is deleted',
      should: 'resolve anonymous immediately (no cookie cache)',
      actual: [before, (await identifyAs(cookie)).state],
      expected: ['member', 'anonymous'],
    });
  });

  test('server reads never slide a session; the browser refresh slides row and cookie together', async () => {
    const { email, cookie, response } = await signUp();
    // Age the session past updateAge (1 day) without expiring it (7 days).
    await withSql(
      (sql) =>
        sql`UPDATE session SET expires_at = now() + interval '5 days' WHERE user_id = (SELECT id FROM users WHERE email = ${email})`,
    );
    const expiry = async () =>
      (
        (await withSql(
          (sql) =>
            sql`SELECT extract(epoch FROM expires_at - now())::int AS s FROM session s JOIN users u ON u.id = s.user_id WHERE u.email = ${email}`,
        )) as { s: number }[]
      )[0]?.s ?? 0;
    const day = 24 * 60 * 60;
    const aged = await expiry();
    const read = await identifyAs(cookie);
    const afterRead = await expiry();
    const refreshed = await session(response);
    const afterRefresh = await expiry();
    assert({
      given: 'a member session aged past updateAge',
      should:
        'leave the row alone on a server read, and extend it with a new cookie through get-session',
      actual: {
        read: read.state,
        readLeftRow: Math.abs(afterRead - aged) < 5,
        refreshStatus: refreshed.status,
        refreshSetsCookie: refreshed.headers
          .getSetCookie()
          .some((line) => line.includes('session_token=')),
        extendedToSevenDays: afterRefresh > 7 * day - 60,
      },
      expected: {
        read: 'provisional',
        readLeftRow: true,
        refreshStatus: 200,
        refreshSetsCookie: true,
        extendedToSevenDays: true,
      },
    });
  });

  test('server session reads spend no auth budget, even from one busy client', async () => {
    const { cookie } = await signUp();
    await claim(cookie, { username: uniqueName() });
    const client = newClient();
    const before = (await redisKeys()).length;
    // 150 page renders from one address (a classroom behind one NAT): a
    // budgeted read would refuse everything past the hundredth.
    const states = await Promise.all(
      Array.from({ length: 150 }, () => identifyAs(cookie, client)),
    );
    assert({
      given: '150 server-side session reads for one member from one client',
      should: 'resolve every one as the member and create no rate-limit key',
      actual: {
        states: [...new Set(states.map((identity) => identity.state))],
        newKeys: (await redisKeys()).length - before,
      },
      expected: { states: ['member'], newKeys: 0 },
    });
  });

  test('a request with no session cookie reads nothing and spends no budget', async () => {
    const before = (await redisKeys()).length;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        identifyAs('x=1; offense-demo-theme=dark'),
      ),
    );
    assert({
      given: 'twenty requests carrying only unrelated cookies',
      should: 'resolve anonymous without creating any rate-limit key',
      actual: {
        states: [...new Set(results.map((identity) => identity.state))],
        newKeys: (await redisKeys()).length - before,
      },
      expected: { states: ['anonymous'], newKeys: 0 },
    });
  });

  test('the server asks the browser to refresh only once updateAge has passed', async () => {
    const { email, cookie } = await signUp();
    const now = () => new Date().toISOString();
    const fresh = await sessionAs(cookie);
    await withSql(
      (sql) =>
        sql`UPDATE session SET expires_at = now() + interval '5 days' WHERE user_id = (SELECT id FROM users WHERE email = ${email})`,
    );
    const aged = await sessionAs(cookie);
    const anonymous = await sessionAs('x=1');
    const due = (expiresAt: string | null) =>
      expiresAt !== null && sessionRefreshDue(expiresAt, now());
    assert({
      given:
        'a new session, the same session aged past updateAge, and a visitor',
      should: 'mark only the aged session as due for a browser refresh',
      actual: [
        due(fresh.sessionExpiresAt),
        due(aged.sessionExpiresAt),
        anonymous.sessionExpiresAt,
      ],
      expected: [false, true, null],
    });
  });

  test('an expired session is anonymous', async () => {
    const { email, cookie } = await signUp();
    await withSql(
      (sql) =>
        sql`UPDATE session SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = ${email})`,
    );
    assert({
      given: 'a session past its expiry',
      should: 'resolve anonymous',
      actual: (await identifyAs(cookie)).state,
      expected: 'anonymous',
    });
  });
});

describe('sign-in request through the real endpoint', () => {
  test('a link request carries the destination and a new-user onboarding route', async () => {
    const email = flows.fresh();
    const { response, link } = await requestLink(email, {
      callbackURL: '/app?view=next',
      newUserCallbackURL: '/onboarding/username?next=%2Fapp%3Fview%3Dnext',
    });
    assert({
      given: 'the sign-in page asking for a link with its destinations',
      should: 'email a /auth/confirm link that carries both',
      actual: [
        response.status,
        link?.searchParams.get('callbackURL'),
        link?.searchParams.get('newUserCallbackURL'),
        tokenOf(link as URL).length > 16,
      ],
      expected: [
        200,
        '/app?view=next',
        '/onboarding/username?next=%2Fapp%3Fview%3Dnext',
        true,
      ],
    });
  });
});
