import {
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import { expect, openPage, test } from './support/fixtures';
import {
  confirmSignIn,
  emailedLink,
  freshEmail,
  origin,
  requestSignInLink,
  resetRateLimits,
  signUpMember,
  signUpProvisional,
} from './support/accounts';
import { changeEmail } from './support/forms';
import { hydrated } from './support/hydration';
import { removeRowByClick, securityRows } from './support/security-rows';

/**
 * A second, genuinely independent session for the same account, signed in
 * through the real UI in its own browser context. Returns it open, for the
 * caller to revoke and check.
 */
async function signInSecondSession(
  browser: Browser,
  request: APIRequestContext,
  email: string,
) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: origin,
  });
  const otherPage = await openPage(context, 'the other device');
  await otherPage.goto('/sign-in');
  await requestSignInLink(otherPage, email);
  await otherPage.goto(await emailedLink(request, email));
  await otherPage
    .getByRole('button', { name: 'Sign in to Offense Demo' })
    .click();
  await expect(otherPage).toHaveURL(/\/app$/);
  return { context, otherPage };
}

/** A fresh member account, signed in twice: `page` and a second context. */
async function memberWithSecondSession(
  page: Page,
  request: APIRequestContext,
  browser: Browser,
) {
  const { email } = await signUpMember(page.request);
  const { context, otherPage } = await signInSecondSession(
    browser,
    request,
    email,
  );
  return { email, context, otherPage };
}

/**
 * Submits an email change once the security page has hydrated: under load
 * hydration can lag first paint by seconds (ISSUE-84), and a click in that
 * gap submits nothing the notice can answer.
 */
async function submitEmailChange(page: Page, newEmail: string) {
  await hydrated(page.getByRole('button', { name: 'Change email' }));
  await changeEmail(page, newEmail);
}

/**
 * The old-inbox approval hop, then the new-inbox verification hop, each a
 * real emailed link opened and confirmed; lands on account security once
 * both are spent.
 */
async function approveAndVerifyEmailChange(
  page: Page,
  request: APIRequestContext,
  oldEmail: string,
  newEmail: string,
) {
  const approveLink = await emailedLink(request, oldEmail);
  await page.goto(approveLink);
  await page.getByRole('button', { name: 'Continue' }).click();
  const verifyLink = await emailedLink(request, newEmail);
  await page.goto(verifyLink);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/settings\/security$/);
  return { verifyLink };
}

/**
 * Submits a change to a fresh address from the security page (waiting for
 * the same-shape approval notice), then spends both emailed hops. Returns
 * the new address and the already-consumed verification link, for a test
 * that replays it.
 */
async function requestAndApproveEmailChange(
  page: Page,
  request: APIRequestContext,
  oldEmail: string,
) {
  const newEmail = freshEmail();
  await submitEmailChange(page, newEmail);
  await expect(page.locator('#email-change-notice')).toContainText(
    /approve this change/i,
  );
  const { verifyLink } = await approveAndVerifyEmailChange(
    page,
    request,
    oldEmail,
    newEmail,
  );
  return { newEmail, verifyLink };
}

/**
 * Signs the page's own session out, then back in through the real sign-in
 * form with a fresh magic link, proving the given address now authenticates
 * the account. Sign-out works only once hydrated (ISSUE-93 keeps it a
 * script button), and under load the page can paint well before that
 * (ISSUE-84).
 */
async function signOutAndSignInWithEmail(
  page: Page,
  request: APIRequestContext,
  email: string,
) {
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await hydrated(signOut);
  await signOut.click();
  await page.waitForURL(/\/sign-in/);
  await page.goto('/sign-in');
  await requestSignInLink(page, email);
  await confirmSignIn(page, await emailedLink(request, email));
  await expect(page).toHaveURL(/\/app$/);
}

/**
 * Session listing/revocation and recovery-email change (AUTH-5.5, AUTH-5.6):
 * unlike passkey-lifecycle.e2e.ts's WebAuthn ceremonies, none of this uses
 * CDP virtual authenticators, so it belongs in the cross-browser/mobile auth
 * journey specs rather than a Chromium-only file (ISSUE-167: the whole of
 * passkey-lifecycle.e2e.ts, sessions and email change included, used to be
 * excluded from Firefox and WebKit for no reason that applied to these
 * tests).
 */
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test('a provisional account (no username yet) can still reach account security settings (ISSUE-167)', async ({
  page,
}) => {
  await signUpProvisional(page.request);
  await page.goto('/settings/security');
  await expect(page).toHaveURL(/\/settings\/security$/);
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
});

test('sessions can be listed and another session revoked; the revoked cookie is refused next', async ({
  page,
  request,
  browser,
}) => {
  const { context: other, otherPage } = await memberWithSecondSession(
    page,
    request,
    browser,
  );

  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Sessions' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  // One "Sign out" per other session row, plus the page's own sign-out
  // control; both happen to share the same label.
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toHaveCount(2);

  await page
    .getByRole('button', { name: 'Sign out of all other sessions' })
    .click();
  // The revocation reloads the list; wait for the other session's row (and
  // its "Sign out" button) to disappear before proving its cookie is
  // actually refused next.
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toHaveCount(1);
  await otherPage.goto('/app');
  await expect(otherPage).toHaveURL(/\/sign-in/);
  await other.close();
});

test("another session's own row Sign out button revokes it, and its cookie is refused on its next request (ISSUE-167, ISSUE-174)", async ({
  page,
  request,
  browser,
}) => {
  const { context: other, otherPage } = await memberWithSecondSession(
    page,
    request,
    browser,
  );

  await page.goto('/settings/security');
  // The per-row button lives inside the sessions list; the page's own
  // "Sign out" control (same label) sits outside it and is never matched.
  const sessionRows = securityRows(page, 'Sessions');
  const rowSignOut = sessionRows.getByRole('button', {
    name: 'Sign out',
    exact: true,
  });
  await expect(rowSignOut).toHaveCount(1);
  await removeRowByClick(sessionRows, rowSignOut, 2);
  await expect(sessionRows).toContainText('This device');

  // The revoked session's own cookie, on its very next requests: the
  // server refuses it, not only a client-side redirect.
  const revoked = await otherPage.request.get(
    '/api/auth/get-session?disableCookieCache=true',
  );
  expect(await revoked.json()).toBeNull();
  await otherPage.goto('/app');
  await expect(otherPage).toHaveURL(/\/sign-in/);

  await other.close();
});

test('an email change is approved from the old inbox and verified at the new one', async ({
  page,
  request,
}) => {
  const { email } = await signUpMember(page.request);
  await page.goto('/settings/security');

  const { newEmail } = await requestAndApproveEmailChange(page, request, email);

  // The redirect alone doesn't prove the account now owns newEmail; prove
  // it by signing back in with a magic link sent to the new address.
  await signOutAndSignInWithEmail(page, request, newEmail);
});

test('a conflicting email answers the same success shape, and leaves both accounts on their own address (AUTH-5.6-AC3, ISSUE-161)', async ({
  page,
  request,
  browser,
}) => {
  const other = await signUpMember(page.request);
  const requester = await signUpMember(page.request); // the requester whose browser context we drive
  await page.goto('/settings/security');

  await submitEmailChange(page, other.email);
  await expect(page.locator('#email-change-notice')).toContainText(
    /approve this change/i,
  );

  // Approving from the old inbox must not move the requester's account onto
  // an address `other` already owns: the taken check settles at approval,
  // observable only from `other`'s own inbox, never the requester's.
  const approveLink = await emailedLink(request, requester.email);
  await page.goto(approveLink);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/settings\/security$/);

  // The requester's account still answers with, and still signs in with,
  // its original address.
  const requesterSession = await page.request.get('/api/auth/get-session');
  const requesterBody = (await requesterSession.json()) as {
    user: { email: string };
  };
  expect(requesterBody.user.email).toBe(requester.email);

  await signOutAndSignInWithEmail(page, request, requester.email);

  // `other`'s account was never touched by the requester's attempt: its own
  // address still signs it in, in a fully independent browser context.
  const otherContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: origin,
  });
  const otherPage = await openPage(otherContext, 'the other device');
  await otherPage.goto('/sign-in');
  await requestSignInLink(otherPage, other.email);
  await confirmSignIn(otherPage, await emailedLink(request, other.email));
  await expect(otherPage).toHaveURL(/\/app$/);
  const otherSession = await otherPage.request.get('/api/auth/get-session');
  const otherBody = (await otherSession.json()) as { user: { email: string } };
  expect(otherBody.user.email).toBe(other.email);
  await otherContext.close();
});

test('a replayed email-change link shows a safe error and leaves the account email unchanged (AUTH-5.6-AC3, ISSUE-161)', async ({
  page,
  request,
}) => {
  const { email } = await signUpMember(page.request);
  await page.goto('/settings/security');

  // A → B, then B → C: the spent A → B verification link would move the
  // account back to B if a replay were ever applied, so "unchanged" (still
  // C) is an assertion that can fail.
  const { newEmail: second, verifyLink: spentLink } =
    await requestAndApproveEmailChange(page, request, email);
  const { newEmail: third } = await requestAndApproveEmailChange(
    page,
    request,
    second,
  );

  await page.goto(spentLink);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: /can no longer be used/i }),
  ).toBeVisible();

  const session = await page.request.get('/api/auth/get-session');
  const body = (await session.json()) as { user: { email: string } };
  expect(body.user.email).toBe(third);
});
