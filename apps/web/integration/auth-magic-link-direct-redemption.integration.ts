import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createFlows } from './auth-mounted-flows';
import { counts, origin } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-3: split from `auth-magic-link.integration.ts` to keep each file
 * under the lint's line limit. Proves the mounted `/api/auth` route refuses
 * to redeem `/magic-link/verify` directly (a login-CSRF and same-origin
 * bypass), while the confirm page's internal forward still works.
 */
requireTestServices(process.env);
setupRitewayBun();
const flows = createFlows();
const { redeem, startSignup, newClient } = flows;

describe('ISSUE-3: direct GET redemption of /magic-link/verify is refused', () => {
  test('a direct GET never creates a session and leaves the token redeemable through the confirm page', async () => {
    const { email, token } = await startSignup();
    const direct = await flows.authRoute.GET(
      new Request(
        `${origin}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        { headers: { [CLIENT_IP_HEADER]: newClient() } },
      ),
    );
    const afterDirectAttempt = await counts(email);
    const legitimate = await redeem(token);
    assert({
      given: 'a direct GET to the mounted /api/auth/magic-link/verify link',
      should:
        'answer 404 with no cookie or session, leaving the token to redeem normally through the confirm page afterwards',
      actual: {
        directStatus: direct.status,
        directCookies: direct.headers.getSetCookie().length,
        countsAfterDirectAttempt: afterDirectAttempt,
        legitimateRedemptionStatus: legitimate.status,
        legitimateCookieIssued: legitimate.headers.getSetCookie().length > 0,
      },
      expected: {
        directStatus: 404,
        directCookies: 0,
        countsAfterDirectAttempt: {
          users: 0,
          sessions: 0,
          verifications: 1,
          passkeys: 0,
        },
        legitimateRedemptionStatus: 303,
        legitimateCookieIssued: true,
      },
    });
  });

  // Negative control: this exercises the same fake-handler path
  // `handlers.test.ts` proves the guard against directly, but here it
  // asserts the invariant that would break if `DIRECT_REDEMPTION_BLOCKED_PATHS`
  // were ever removed from the mounted route — a direct GET would then
  // redeem the token itself, and the counts assertion above would flip to
  // `sessions: 1`. This test alone would fail without the guard.
  test('POST to /magic-link/verify is refused the same way', async () => {
    const { token } = await startSignup();
    const direct = await flows.authRoute.POST(
      new Request(
        `${origin}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { origin, [CLIENT_IP_HEADER]: newClient() },
        },
      ),
    );
    assert({
      given: 'a direct POST to the mounted /api/auth/magic-link/verify link',
      should: 'answer 404 with no cookie',
      actual: {
        status: direct.status,
        cookies: direct.headers.getSetCookie().length,
      },
      expected: { status: 404, cookies: 0 },
    });
  });
});
