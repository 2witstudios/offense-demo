import { expect, test } from './support/fixtures';
import { resetRateLimits } from './support/accounts';
import {
  reachRetryState,
  reachSentState,
  requestConfirmLink,
} from './support/confirm-page';
import { watchCspViolations } from './support/csp';

/**
 * AUTH-4.7's CSP proofs, split from csp.e2e.ts so they run on every
 * Playwright project (ISSUE-166's fourth criterion): the home page CSP test
 * stays chromium-only, but the confirm and email-change pages' nonce and
 * violation-free rendering must hold on every engine, since Firefox and
 * WebKit enforce style-src nonces themselves.
 */

// A fixed-shape token: real redemption is never exercised here, only that
// the view renders with a style nonce.
const token = 'e2eTokenNotARealCredential0123456789';

test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test('the confirm page style nonce equals the response CSP header nonce (AUTH-4.7)', async ({
  request,
}) => {
  const response = await request.get(`/auth/confirm?token=${token}`);
  const policy = response.headers()['content-security-policy'] ?? '';
  const headerNonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  const html = await response.text();
  const styleNonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
  expect(headerNonce).toBeTruthy();
  expect(styleNonce).toBe(headerNonce);
});

test('AUTH-4.7: every confirm-page state renders under the production CSP without violations', async ({
  page,
  request,
}) => {
  const violations = await watchCspViolations(page);

  // confirm
  const { link } = await requestConfirmLink(page, request);
  await page.goto(link);
  await expect(
    page.getByRole('button', { name: 'Sign in to Offense Demo' }),
  ).toBeVisible();

  // expired, then sent (a separate link, spent then resent)
  await reachSentState(page, request);

  // retry ("too many attempts")
  await resetRateLimits(request);
  await reachRetryState(page, request);

  // email-change confirm page
  await page.goto(`/auth/confirm-email?token=${'a'.repeat(43)}`);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

  expect(await violations.read()).toEqual({
    eventViolations: [],
    consoleViolations: [],
  });
});
