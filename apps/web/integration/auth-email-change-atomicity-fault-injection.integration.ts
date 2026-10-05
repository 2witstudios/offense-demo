import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import { createPasskeyFlows } from './auth-passkey-flows';
import { withOutboxInsertBlockedForTopic } from './auth-outbox-helpers';
import { cookieHeader, userIdOf } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-23: the after-hook revoke-other-sessions failure path on
 * /verify-email was previously proven only by a rejecting stub
 * (revoke-others-on-verify-email.test.ts) or a fake handler that set the
 * header directly (confirm-email.test.ts). This forces a real database
 * fault into a live /verify-email redemption, through the confirm page
 * (per ISSUE-3 AC4), the same real-fault technique
 * auth-session-revoked-outbox.integration.ts uses: a topic-scoped
 * `BEFORE INSERT` trigger is a genuine Postgres-level failure of the exact
 * statement `appendOutboxEvent` issues, never a stub of the function under
 * test, and it rejects no other topic's inserts.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { withLoggedEvents } = flows.account.flows.testApp;

describe('ISSUE-23 a real fault injected into revokeOtherSessions during /verify-email', () => {
  test('a forced outbox failure inside the atomic revocation rolls back the session delete too', async () => {
    const { email, cookie } = await flows.account.signUp();
    const { redeem } = flows.account.flows;
    const otherToken = await flows.account.flows.linkTokenFor(email);
    const otherCookie = cookieHeader(await redeem(otherToken));
    const { verifyToken } = await flows.confirmedEmailChange(cookie);

    const uid = (await userIdOf(email)) ?? '';

    let completion!: Response;
    const { events: loggedEvents } = await withLoggedEvents(() =>
      withOutboxInsertBlockedForTopic(buildUserInboxTopic(uid), async () => {
        completion = await flows.confirmEmailPost(verifyToken);
      }),
    );

    assert({
      given:
        "the atomic revocation's outbox append failing at the database level",
      should:
        'report the cleanup step failed, still carry the new session cookie, leave the other session authenticated (the DELETE rolled back with it), and log the cleanup-failed event',
      actual: {
        status: completion.status,
        carriesNewSessionCookie: completion.headers.getSetCookie().length > 0,
        otherSessionStillAuthenticated:
          await flows.isAuthenticated(otherCookie),
        loggedCleanupFailed: loggedEvents.includes(
          'auth.email_change.cleanup_failed',
        ),
      },
      expected: {
        status: 502,
        carriesNewSessionCookie: true,
        otherSessionStillAuthenticated: true,
        loggedCleanupFailed: true,
      },
    });
  });
});
