import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows } from './auth-passkey-flows';
import { userIdOf } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-22 (owner decision, 2026-09-23): every revoke-all is serialized in
 * the database against session creation for the user, which `@offense-demo/db`'s
 * `revokeOtherSessions` does with a user-row lock (its race is proven in
 * `packages/db/integration/session-revoke-all-race.integration.ts`). Better
 * Auth's own `/revoke-other-sessions` lists the sessions and then deletes
 * them one by one, and `/revoke-sessions` deletes without the lock, so both
 * mounted endpoints must reach that one operation instead.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;
const { signInAgain, app } = flows.account.flows;

/** Records each call to the app's real revoke-all while passing it through. */
const spyOnRevokeAll = () => {
  const { database } = app;
  const real = database.revokeOtherSessions.bind(database);
  const calls: Array<readonly [string, string | null]> = [];
  database.revokeOtherSessions = async (userId, keepToken) => {
    calls.push([userId, keepToken]);
    return real(userId, keepToken);
  };
  return { calls, restore: () => (database.revokeOtherSessions = real) };
};

describe('ISSUE-22 the self-service revoke-all endpoints use the serialized revoke', () => {
  test('/revoke-other-sessions revokes through the locked operation and keeps the caller', async () => {
    const { email, cookie: current } = await signUp();
    const other = await signInAgain(email);
    const uid = (await userIdOf(email)) ?? '';
    const currentToken =
      (await flows.serverSession(current))?.session.token ?? '';
    const spy = spyOnRevokeAll();
    let response: Response;
    try {
      response = await flows.revokeOtherSessions(current);
    } finally {
      spy.restore();
    }
    assert({
      given: 'a fresh session revoking every other session of its account',
      should:
        'call the serialized revoke once with the caller kept, sign the other session out and keep the caller',
      actual: {
        status: response.status,
        // Labels, not the bearer token itself, so a failure never prints it.
        calls: spy.calls.map(([userId, keep]) => [
          userId === uid,
          keep === currentToken ? 'caller' : keep && 'another token',
        ]),
        current: await flows.isAuthenticated(current),
        other: await flows.isAuthenticated(other),
      },
      expected: {
        status: 200,
        calls: [[true, 'caller']],
        current: true,
        other: false,
      },
    });
  });

  test('/revoke-sessions revokes every session, the caller included, through the locked operation', async () => {
    const { email, cookie: current } = await signUp();
    const other = await signInAgain(email);
    const uid = (await userIdOf(email)) ?? '';
    const spy = spyOnRevokeAll();
    let response: Response;
    try {
      response = await flows.revokeSessions(current);
    } finally {
      spy.restore();
    }
    assert({
      given: 'a fresh session revoking all sessions of its account',
      should:
        'call the serialized revoke once keeping nothing, and sign both sessions out',
      actual: {
        status: response.status,
        calls: spy.calls.map(([userId, keep]) => [
          userId === uid,
          keep && 'a token',
        ]),
        current: await flows.isAuthenticated(current),
        other: await flows.isAuthenticated(other),
      },
      expected: {
        status: 200,
        calls: [[true, null]],
        current: false,
        other: false,
      },
    });
  });
});
