import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows } from './auth-passkey-flows';
import { origin } from './fixtures';
import { trackRevocations } from './auth-outbox-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { recordedEvents } = flows;
const { newClient } = flows.account.flows;
const { signUp } = flows.account;
const { authRoute } = flows;

/** Reads the current session with cookie caching disabled, as production does. */
const protectedRead = (cookie: string) =>
  authRoute.GET(
    new Request(`${origin}/api/auth/get-session?disableCookieCache=true`, {
      headers: { cookie, [CLIENT_IP_HEADER]: newClient() },
    }),
  );

/**
 * An ordinary `/get-session` call with no per-request cache bypass — what
 * every caller other than this suite's own explicit checks actually sends.
 * Its freshness depends entirely on the server's own
 * `session.cookieCache: { enabled: false }` (`server.ts`), not on any
 * request-side opt-out.
 */
const plainRead = (cookie: string) =>
  authRoute.GET(
    new Request(`${origin}/api/auth/get-session`, {
      headers: { cookie, [CLIENT_IP_HEADER]: newClient() },
    }),
  );

/**
 * `/get-session` always answers 200; a revoked, expired or absent session is
 * a `null` body, not an error status, so the live signal is the body itself.
 */
const isAuthenticated = async (response: Response): Promise<boolean> =>
  (await response.clone().json()) !== null;

/**
 * A session's token, read on the server through auth.api as Offense Demo's own
 * routes do: browser responses never carry it (ISSUE-63).
 */
const sessionTokenOf = async (cookie: string): Promise<string> =>
  (await flows.serverSession(cookie))?.session.token ?? '';

const sessionUserIdOf = async (response: Response): Promise<string> =>
  ((await response.clone().json()) as { session?: { userId: string } } | null)
    ?.session?.userId ?? '';

describe('AUTH-5.5 session management', () => {
  test('a second sign-in creates a second session, both listed for the account', async () => {
    const { email, cookie: first } = await signUp();
    await flows.account.flows.requestLink(email);
    // A second real magic-link sign-in for the same account: a genuinely
    // independent session, not a fixture.
    await flows.account.flows.signInAgain(email);
    const rows = await flows.listSessions(first);
    assert({
      given: 'one account signed in twice',
      should: 'list two distinct active sessions',
      actual: {
        count: rows.length,
        distinctTokens: new Set(rows.map((r) => r.token)).size,
      },
      expected: { count: 2, distinctTokens: 2 },
    });
  });

  test('revoking a specific other session denies its next protected request, with cookie caching disabled', async () => {
    const { email, cookie: first } = await signUp();
    const second = await flows.account.flows.signInAgain(email);
    const before = await protectedRead(second);
    const secondToken = await sessionTokenOf(second);
    const userId = await sessionUserIdOf(before);
    const revocations = await trackRevocations(userId);
    try {
      await flows.revokeSession(first, secondToken);
      const after = await protectedRead(second);
      assert({
        given: 'a named other session revoked from the current one',
        should:
          'let the first request through, deny the next with a fresh (non-cached) read, and append session.revoked to the outbox (RT-2.2)',
        actual: {
          beforeAuthenticated: await isAuthenticated(before),
          afterAuthenticated: await isAuthenticated(after),
          outboxEventsAppended: await revocations.appended(),
        },
        expected: {
          beforeAuthenticated: true,
          afterAuthenticated: false,
          outboxEventsAppended: 1,
        },
      });
    } finally {
      await revocations.cleanup();
    }
  });

  test('revoking a specific session and revoking every other session each emit their own lifecycle event (AUTH-6.4)', async () => {
    const { email, cookie: first } = await signUp();
    const { requestLink, redeem } = flows.account.flows;
    const second = await flows.account.flows.signInAgain(email);
    const secondToken = await sessionTokenOf(second);
    const singleEvents = await recordedEvents(async () => {
      await flows.revokeSession(first, secondToken);
    });

    const { link: linkB } = await requestLink(email);
    await redeem(new URL(linkB as URL).searchParams.get('token') ?? '');
    const allEvents = await recordedEvents(async () => {
      await flows.revokeOtherSessions(first);
    });

    assert({
      given:
        'revoking one named other session, then revoking every other session',
      should:
        'emit auth.session.revoked and auth.session.revoked_all respectively',
      actual: {
        single: singleEvents.includes('auth.session.revoked'),
        all: allEvents.includes('auth.session.revoked_all'),
      },
      expected: { single: true, all: true },
    });
  });

  test('a revoked session is denied even by an ordinary read that never asked to bypass the cache', async () => {
    const { email, cookie: first } = await signUp();
    const second = await flows.account.flows.signInAgain(email);
    const before = await plainRead(second);
    const secondToken = await sessionTokenOf(second);
    await flows.revokeSession(first, secondToken);
    const after = await plainRead(second);
    assert({
      given:
        'a named other session revoked, then read back with no `disableCookieCache` opt-out',
      should:
        "deny it anyway — the server's own cookieCache:{enabled:false} setting, not the caller, is what keeps this fresh",
      actual: {
        beforeAuthenticated: await isAuthenticated(before),
        afterAuthenticated: await isAuthenticated(after),
      },
      expected: { beforeAuthenticated: true, afterAuthenticated: false },
    });
  });

  test('revoking other sessions leaves the current session usable and every other one denied', async () => {
    const { email, cookie: first } = await signUp();
    const secondCookie = await flows.account.flows.signInAgain(email);
    const thirdCookie = await flows.account.flows.signInAgain(email);
    const userId = await sessionUserIdOf(await protectedRead(first));
    const revocations = await trackRevocations(userId);
    try {
      const revoke = await flows.revokeOtherSessions(first);
      const [currentAfter, secondAfter, thirdAfter] = await Promise.all([
        protectedRead(first),
        protectedRead(secondCookie),
        protectedRead(thirdCookie),
      ]);
      assert({
        given: 'revoke-other-sessions called from the first session',
        should:
          'keep the calling session live, deny every other one, and append one session.revoked doorbell for the call (RT-2.2)',
        actual: {
          revoked: revoke.ok,
          current: await isAuthenticated(currentAfter),
          second: await isAuthenticated(secondAfter),
          third: await isAuthenticated(thirdAfter),
          outboxEventsAppended: await revocations.appended(),
        },
        expected: {
          revoked: true,
          current: true,
          second: false,
          third: false,
          outboxEventsAppended: 1,
        },
      });
    } finally {
      await revocations.cleanup();
    }
  });

  test("revoking every session (including the caller's own) denies it too, and appends one session.revoked doorbell for the call (RT-2.2)", async () => {
    const { email, cookie: first } = await signUp();
    const secondCookie = await flows.account.flows.signInAgain(email);
    const userId = await sessionUserIdOf(await protectedRead(first));
    const revocations = await trackRevocations(userId);
    try {
      const revoke = await flows.revokeSessions(first);
      const [firstAfter, secondAfter] = await Promise.all([
        protectedRead(first),
        protectedRead(secondCookie),
      ]);
      assert({
        given: 'revoke-sessions (revoke-all) called from the first session',
        should:
          'deny the calling session too, deny every other one, and append one session.revoked doorbell for the call (RT-2.2)',
        actual: {
          revoked: revoke.ok,
          first: await isAuthenticated(firstAfter),
          second: await isAuthenticated(secondAfter),
          outboxEventsAppended: await revocations.appended(),
        },
        expected: {
          revoked: true,
          first: false,
          second: false,
          outboxEventsAppended: 1,
        },
      });
    } finally {
      await revocations.cleanup();
    }
  });

  // Better Auth answers 200/{status:true} for a foreign token too, so an
  // attacker cannot use the response to learn whether a token exists; the
  // only observable, security-relevant fact is that nothing was revoked.
  test("another user's session token does not revoke it", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const bobToken = await sessionTokenOf(bob.cookie);
    await flows.revokeSession(alice.cookie, bobToken);
    const stillLive = await protectedRead(bob.cookie);
    assert({
      given: "alice naming bob's session token",
      should: "leave bob's session live",
      actual: await isAuthenticated(stillLive),
      expected: true,
    });
  });

  test('an anonymous request is refused for revoking sessions', async () => {
    const anonymous = await flows.revokeSessions('');
    assert({
      given: 'no session cookie at all',
      should: 'refuse the revocation',
      actual: anonymous.ok,
      expected: false,
    });
  });
});
