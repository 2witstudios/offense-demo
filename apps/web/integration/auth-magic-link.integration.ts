import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createFlows } from './auth-mounted-flows';
import { counts, origin, tokenOf, withSql } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { emailedLinkIdentifier } from '../src/features/auth/emailed-link-token';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const flows = createFlows();
const { requestLink, redeem, confirmGet, confirmRoute, startSignup } = flows;
const { mailbox, newClient, formPost } = flows;

describe('AUTH-3.3 magic link request through the mounted handler', () => {
  test('a new email gets an account-neutral answer and exactly one /auth/confirm link', async () => {
    const { response, mail, link, email } = await startSignup();
    assert({
      given: 'a new email requested through the mounted /api/auth handler',
      should:
        'answer neutrally and send exactly one message with a /auth/confirm link',
      actual: {
        status: response.status,
        body: await response.json(),
        noStore: response.headers.get('cache-control'),
        hasRequestId: Boolean(response.headers.get('x-request-id')),
        to: mail?.to === email,
        subject: mail?.subject,
        path: link.pathname,
        callback: link.searchParams.get('callbackURL'),
        idempotent: Boolean(mail?.idempotencyKey),
      },
      expected: {
        status: 200,
        body: { status: true },
        noStore: 'no-store',
        hasRequestId: true,
        to: true,
        subject: 'Sign in to Offense Demo',
        path: '/auth/confirm',
        callback: '/app',
        idempotent: true,
      },
    });
  });

  test('the token is stored as its purpose-scoped SHA3-256 digest with a five-minute expiry and no user exists yet (ISSUE-2)', async () => {
    const { email, token } = await startSignup();
    const stored = await withSql(
      (sql) =>
        // Better Auth stamps both timestamps from one clock in one call.
        sql`SELECT identifier, round(extract(epoch from (expires_at - created_at)))::int AS lifetime FROM verification WHERE strpos(value, ${email}) > 0`,
    );
    const plaintext = await withSql(
      (sql) => sql`SELECT 1 FROM verification WHERE identifier = ${token}`,
    );
    assert({
      given: 'the persisted verification record for a fresh link',
      should:
        'hold the sign-in purpose and SHA3-256 digest of an opaque 256-bit token (never the token), expire within five minutes and create no user',
      actual: {
        rows: stored.length,
        opaque256: /^[A-Za-z0-9_-]{43}$/.test(token),
        identifier: stored[0]?.identifier,
        plaintextLookup: plaintext.length,
        lifetimeSeconds: stored[0]?.lifetime,
        counts: await counts(email),
      },
      expected: {
        rows: 1,
        opaque256: true,
        identifier: emailedLinkIdentifier('sign-in', token),
        plaintextLookup: 0,
        lifetimeSeconds: 300,
        counts: { users: 0, sessions: 0, verifications: 1, passkeys: 0 },
      },
    });
  });
});

describe('AUTH-3.5 scanner-safe confirmation and single-use redemption', () => {
  test('GET and HEAD visits (scanner, prefetch) render a safe page without redeeming', async () => {
    const { email, link } = await startSignup();
    const scans = await Promise.all([
      confirmGet(link),
      confirmGet(link, 'HEAD'),
      confirmGet(link),
      confirmGet(link, 'HEAD'),
    ]);
    const page = await scans[0]?.text();
    assert({
      given: 'GET and HEAD visits to the emailed URL',
      should:
        'return a no-store, referrer-free page with no cookie, asset or redemption',
      actual: {
        statuses: scans.map((scan) => scan.status),
        setCookies: scans.map((scan) => scan.headers.getSetCookie().length),
        noStore: scans.map((scan) => scan.headers.get('cache-control')),
        referrer: scans[0]?.headers.get('referrer-policy'),
        headBodies: [await scans[1]?.text(), await scans[3]?.text()],
        formPosts: page?.includes('method="post" action="/auth/confirm"'),
        noAssets: !/<script|<link|<img|<iframe|(src|href)="https?:/i.test(
          page ?? '',
        ),
        counts: await counts(email),
      },
      expected: {
        statuses: [200, 200, 200, 200],
        setCookies: [0, 0, 0, 0],
        noStore: Array(4).fill('no-store'),
        referrer: 'no-referrer',
        headBodies: ['', ''],
        formPosts: true,
        noAssets: true,
        counts: { users: 0, sessions: 0, verifications: 1, passkeys: 0 },
      },
    });
  });

  test('an explicit same-origin POST redeems the exact emitted token once: token-free redirect, verified user, session and working cookie', async () => {
    const { email, token } = await startSignup();
    const confirmed = await redeem(token, {
      newUserCallbackURL: '/onboarding/username',
    });
    const location = confirmed.headers.get('location') ?? '';
    const active = await flows.session(confirmed);
    const body = (await active.json()) as {
      user?: { email?: string; emailVerified?: boolean };
    };
    const users = await flows.userRows(email);
    const sessions = await withSql(
      (sql) =>
        sql`SELECT s.user_id FROM session s JOIN users u ON u.id = s.user_id WHERE u.email = ${email}`,
    );
    assert({
      given: 'a confirmation POST of the exact emitted token',
      should:
        'redirect without the token, persist one verified cuid2 user and session, and the cookie must authenticate',
      actual: {
        status: confirmed.status,
        location,
        tokenInLocation: location.includes(token),
        cookie: confirmed.headers.getSetCookie().length > 0,
        users: users.length,
        sessions: sessions.length,
        sameUser: sessions[0]?.user_id === users[0]?.id,
        verified: users[0]?.email_verified === true,
        cuid2: /^[a-z0-9]{24}$/.test(users[0]?.id ?? ''),
        cookieAuthenticates: body.user?.email === email,
        emailVerified: body.user?.emailVerified,
      },
      expected: {
        status: 303,
        location: '/onboarding/username',
        tokenInLocation: false,
        cookie: true,
        users: 1,
        sessions: 1,
        sameUser: true,
        verified: true,
        cuid2: true,
        cookieAuthenticates: true,
        emailVerified: true,
      },
    });
  });

  test('a replay of a consumed token fails with no cookie, extra session or duplicate user', async () => {
    const { email, token } = await startSignup();
    await redeem(token);
    const replay = await redeem(token);
    assert({
      given: 'a replay of the already-consumed token',
      should: 'redirect to the expired view without authenticating again',
      actual: {
        status: replay.status,
        location: replay.headers.get('location'),
        cookies: replay.headers.getSetCookie().length,
        counts: await counts(email),
      },
      expected: {
        status: 303,
        location: '/auth/confirm?error=INVALID_TOKEN',
        cookies: 0,
        counts: { users: 1, sessions: 1, verifications: 0, passkeys: 0 },
      },
    });
  });

  test('concurrent redemption of one token authenticates exactly once', async () => {
    const { email, token } = await startSignup();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => redeem(token)),
    );
    const cookies = (result: Response) => result.headers.getSetCookie().length;
    assert({
      given: 'sixteen simultaneous confirmations of the same token',
      should: 'issue exactly one session cookie, one user and one session',
      actual: {
        winners: results.filter((result) => cookies(result) > 0).length,
        losers: results
          .filter((result) => cookies(result) === 0)
          .map((result) => result.headers.get('location')),
        counts: await counts(email),
      },
      expected: {
        winners: 1,
        losers: Array(15).fill('/auth/confirm?error=INVALID_TOKEN'),
        counts: { users: 1, sessions: 1, verifications: 0, passkeys: 0 },
      },
    });
  });
});

describe('AUTH-3.3 / AUTH-3.5 returning users and expired links', () => {
  test('a returning user (case-varied address) reuses the account and honors a local destination', async () => {
    const { email, token } = await startSignup();
    await redeem(token);
    const second = await requestLink(email.toUpperCase(), {
      callbackURL: '/play?tab=rules',
    });
    const destination = second.link?.searchParams.get('callbackURL') ?? '';
    const confirmed = await redeem(tokenOf(second.link as URL), {
      callbackURL: destination,
    });
    assert({
      given: 'a returning user with a local destination',
      should: 'redirect there with a fresh session and still exactly one user',
      actual: {
        location: confirmed.headers.get('location'),
        counts: await counts(email),
      },
      expected: {
        location: '/play?tab=rules',
        counts: { users: 1, sessions: 2, verifications: 0, passkeys: 0 },
      },
    });
  });

  test('an expired link fails and the expired view sends nothing by itself', async () => {
    const { email, token } = await startSignup();
    // Move the stored expiry into the past instead of waiting five minutes.
    await withSql(
      (sql) =>
        sql`UPDATE verification SET expires_at = now() - interval '1 minute' WHERE value LIKE ${`%${email}%`}`,
    );
    const expired = await redeem(token);
    const before = mailbox.mails.length;
    const view = await confirmRoute.GET(
      new Request(`${origin}${expired.headers.get('location')}`, {
        headers: { [CLIENT_IP_HEADER]: newClient() },
      }),
    );
    const html = await view.text();
    assert({
      given: 'a link past its five-minute expiry',
      should:
        'reject it with no session, then show a resend form without sending on view',
      actual: {
        location: expired.headers.get('location'),
        cookies: expired.headers.getSetCookie().length,
        counts: await counts(email),
        offersResend: html.includes('name="intent" value="resend"'),
        autoSent: mailbox.mails.length - before,
        noStore: view.headers.get('cache-control'),
      },
      expected: {
        location: '/auth/confirm?error=INVALID_TOKEN',
        cookies: 0,
        counts: { users: 0, sessions: 0, verifications: 0, passkeys: 0 },
        offersResend: true,
        autoSent: 0,
        noStore: 'no-store',
      },
    });
  });

  test('the person submitting the resend form gets exactly one new message and a neutral answer', async () => {
    const email = flows.fresh();
    const before = mailbox.mails.length;
    const resend = await confirmRoute.POST(
      formPost({ intent: 'resend', email, callbackURL: '/app' }),
    );
    assert({
      given: 'the resend form submitted for an address',
      should: 'send one message and answer without confirming the account',
      actual: {
        status: resend.status,
        newMails: mailbox.mails.length - before,
        neutral: (await resend.text()).includes(
          'If that address can sign in to Offense Demo',
        ),
      },
      expected: { status: 200, newMails: 1, neutral: true },
    });
  });
});
