import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows } from './auth-passkey-flows';
import { emailOf, userIdOf } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-3, carried onto ISSUE-2's opaque tokens: split from
 * `auth-email-change.integration.ts` to keep each file under the lint's
 * line limit. Proves the mounted `/api/auth` route refuses to redeem an
 * email-change token directly, and that Better Auth's own JWT
 * `/verify-email` is gone, so a linked-to change never completes outside
 * the same-origin confirm page.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;

describe('ISSUE-3: direct redemption of an email-change token is refused', () => {
  test('a direct GET or POST never verifies the change, leaving the token to verify through the confirm page', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const { newEmail, verifyToken } = await flows.confirmedEmailChange(cookie);

    const attempts = [
      await flows.get(
        `/api/auth/email-change/verify?token=${encodeURIComponent(verifyToken)}`,
      ),
      await flows.post('/api/auth/email-change/verify', { token: verifyToken }),
      await flows.get(
        `/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`,
      ),
      await flows.post('/api/auth/send-verification-email', { email }),
    ];
    const emailAfterDirectAttempts = await emailOf(uid);
    const legitimate = await flows.confirmEmailPost(verifyToken);
    const finalEmail = await emailOf(uid);

    assert({
      given:
        'direct GET and POST requests to the mounted email-change redemption, and to Better Auth’s JWT verification routes',
      should:
        'answer 404 with no cookie, changing nothing, and leave the token to verify normally afterward through the confirm page',
      actual: {
        statuses: attempts.map((response) => response.status),
        cookies: attempts.map(
          (response) => response.headers.getSetCookie().length,
        ),
        emailAfterDirectAttempts,
        legitimateStatus: legitimate.status,
        finalEmail,
      },
      expected: {
        statuses: [404, 404, 404, 404],
        cookies: [0, 0, 0, 0],
        emailAfterDirectAttempts: email,
        legitimateStatus: 303,
        finalEmail: newEmail,
      },
    });
  });
});
