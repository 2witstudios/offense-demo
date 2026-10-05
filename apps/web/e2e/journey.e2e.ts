import { expect, openPage, test } from './support/fixtures';
import {
  emailedLink,
  freshEmail,
  confirmSignIn,
  requestSignInLink,
  resetRateLimits,
  signUpMember,
  uniqueName,
  reachOnboarding,
  sessionUsername,
} from './support/accounts';
import { claimUsername, declineOfferToApp } from './support/forms';
import { effectsRan } from './support/hydration';
import { watchTopbarLinks } from './support/topbar';

// The whole sign-in journey in a real browser against the production build:
// request a link on /sign-in, open the emailed link, get a session, pick a
// username, reach a protected page. Mail is captured off the wire by the e2e
// server; nothing is seeded and no session is pre-created.
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test('anonymous visits are sent to sign-in and the whole loop ends on the protected page', async ({
  page,
  request,
}) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);

  const email = freshEmail();
  await requestSignInLink(page, email);
  const link = await emailedLink(request, email);
  await confirmSignIn(page, link);

  // A brand-new account is forced through username onboarding first.
  await expect(page).toHaveURL(/\/onboarding\/username\?next=(\/|%2F)app$/);
  await page.goto('/app?view=next');
  await expect(page).toHaveURL(
    /\/onboarding\/username\?next=%2Fapp%3Fview%3Dnext$/,
  );

  // Recoverable errors: invalid, then a name someone else already owns.
  // The other account only has to own a name, so it signs up through the
  // real handlers without a second page: this page's own loop already walks
  // the UI, and repeating it cost a third of the test on a loaded machine
  // (ISSUE-204).
  const other = await page
    .context()
    .browser()!
    .newContext({
      ignoreHTTPSErrors: true,
      baseURL: page.url().split('/onboarding')[0]!,
    });
  const { username: taken } = await signUpMember(other.request);
  await other.close();

  await page.goto('/onboarding/username?next=%2Fapp');
  await claimUsername(page, 'no spaces allowed');
  await expect(page.locator('#username-notice')).toContainText(
    'That username will not work',
  );
  await claimUsername(page, taken.toUpperCase());
  await expect(page.locator('#username-notice')).toContainText('already taken');
  await expect(page.getByLabel('Username')).toHaveValue(taken.toUpperCase());

  const mine = uniqueName('ada');
  await claimUsername(page, mine.toUpperCase());

  // Declining the passkey offer (real enrollment is covered separately in
  // passkey-lifecycle.e2e.ts, with a virtual authenticator configured).
  await expect(
    page.getByRole('heading', { name: /next time, one tap/i }),
  ).toBeVisible();
  // The safe return destination survived, and the username is the identity.
  await declineOfferToApp(page);
  await page.goto('/');
  await expect(
    page.getByRole('link', { name: `Account settings for ${mine}` }),
  ).toBeVisible();

  // The durable session and the persisted identity survive a reload and a
  // fresh request: the same account, with the username it claimed.
  await page.reload();
  await expect(
    page.getByRole('link', { name: `Account settings for ${mine}` }),
  ).toBeVisible();
  const session = await page.request.get('/api/auth/get-session');
  const body = (await session.json()) as {
    user: { email: string; username: string; emailVerified: boolean };
  };
  expect({
    email: body.user.email,
    username: body.user.username,
    verified: body.user.emailVerified,
  }).toEqual({ email, username: mine, verified: true });
});

test('a redeemed link cannot be replayed', async ({ page, request }) => {
  await page.goto('/sign-in');
  const email = freshEmail();
  await requestSignInLink(page, email);
  const link = await emailedLink(request, email);
  await confirmSignIn(page, link);
  await expect(page).toHaveURL(/\/onboarding\/username/);

  await page.context().clearCookies();
  await confirmSignIn(page, link);
  await expect(
    page.getByRole('heading', { name: /can no longer be used/i }),
  ).toBeVisible();
  await page.goto('/app');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
});

test('an interrupted signup resumes onboarding on the next sign-in', async ({
  page,
  request,
}) => {
  await page.goto('/sign-in?next=%2Fapp%3Fview%3Dnext');
  const email = freshEmail();
  await requestSignInLink(page, email);
  await confirmSignIn(page, await emailedLink(request, email));
  await expect(page).toHaveURL(/\/onboarding\/username/);

  // Walk away without choosing a name, then sign in again later.
  await page.context().clearCookies();
  await resetRateLimits(request);
  await page.goto('/sign-in?next=%2Fapp%3Fview%3Dnext');
  await requestSignInLink(page, email);
  const second = await emailedLink(request, email);
  expect(second).toBeTruthy();
  await page.goto(second);
  await page.getByRole('button', { name: 'Sign in to Offense Demo' }).click();
  await expect(page).toHaveURL(
    /\/onboarding\/username\?next=%2Fapp%3Fview%3Dnext$/,
  );
  await page.goto('/app?view=next');
  await expect(page).toHaveURL(
    /\/onboarding\/username\?next=%2Fapp%3Fview%3Dnext$/,
  );
});

test('declining the passkey offer after onboarding from a protected page other than the signed-in home returns there (AUTH-4.3-AC3, ISSUE-159)', async ({
  page,
  request,
}) => {
  await page.goto('/app?view=next');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%3Fview%3Dnext$/);
  const email = freshEmail();
  await requestSignInLink(page, email);
  await confirmSignIn(page, await emailedLink(request, email));
  await expect(page).toHaveURL(
    /\/onboarding\/username\?next=(\/|%2F)app(\?|%3F)view(=|%3D)next$/,
  );
  await claimUsername(page, uniqueName('member'));
  await expect(
    page.getByRole('heading', { name: /next time, one tap/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page).toHaveURL(/\/app\?view=next$/);
});

test('return destinations are validated and spectator routes stay public', async ({
  page,
  request,
}) => {
  await page.goto('/watch');
  await expect(page).toHaveURL(/\/watch$/);

  await page.goto('/sign-in?next=%2F%2Fevil.example%2Fpath');
  const email = freshEmail();
  await requestSignInLink(page, email);
  await confirmSignIn(page, await emailedLink(request, email));
  await expect(page).toHaveURL(/\/onboarding\/username\?next=(\/|%2F)app$/);
  await claimUsername(page, uniqueName('safe'));
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test('sign-in works by keyboard alone and every control has an accessible name', async ({
  page,
  request,
}) => {
  await page.goto('/sign-in');
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign in with a passkey' }),
  ).toBeVisible();

  const email = freshEmail();
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').focus();
  await page.keyboard.type(email);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: /check your inbox/i }),
  ).toBeVisible();
  await emailedLink(request, email);

  await page
    .getByRole('button', { name: /use a different email/i })
    .press('Enter');
  await expect(page.getByLabel('Email')).toBeVisible();
});

test('a browser without WebAuthn is told so and keeps the email path', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'PublicKeyCredential');
  });
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /cannot use passkeys/i }),
  ).toBeVisible();
  const email = freshEmail();
  await requestSignInLink(page, email);
  await expect(emailedLink(request, email)).resolves.toContain('/auth/confirm');
});

test('an emailed link opened in a different browser than the one that requested it still signs in', async ({
  page,
  request,
  browser,
}) => {
  const email = freshEmail();
  await page.goto('/sign-in');
  await requestSignInLink(page, email);
  const link = await emailedLink(request, email);

  // A genuinely separate browser context: no cookies, storage or history
  // shared with the requesting page (the "opened it on another device"
  // case a bearer magic link must support).
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const otherPage = await openPage(other, 'the other browser');
  await confirmSignIn(otherPage, link);
  await expect(otherPage).toHaveURL(/\/onboarding\/username/);
  await claimUsername(otherPage, uniqueName('cross-browser'));
  await expect(
    otherPage.getByRole('heading', { name: /next time, one tap/i }),
  ).toBeVisible();
  await otherPage.getByRole('button', { name: 'Not now' }).click();
  await expect(otherPage).toHaveURL(/\/app$/);

  // The requesting page never redeemed the link itself and stays anonymous.
  await page.goto('/app');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
  await other.close();
});

test('refreshing or navigating back mid-onboarding does not lose the session or double-claim the username', async ({
  page,
  request,
}) => {
  await reachOnboarding(page, request);

  // A reload mid-flow must not sign the person out or drop the destination.
  await page.reload();
  await expect(page).toHaveURL(/\/onboarding\/username/);

  const name = uniqueName('resumed');
  const offer = page.getByRole('heading', { name: /next time, one tap/i });
  await claimUsername(page, name);
  await expect(offer).toBeVisible();

  // The offer is its own page: a reload keeps it, and the session.
  await page.reload();
  await expect(offer).toBeVisible();

  // The claim never reopens for an account that has a username: the
  // server-rendered onboarding page sends it straight to its destination,
  // and going back from there returns to the offer, not to a claim form.
  await page.goto('/onboarding/username?next=%2Fapp');
  await expect(page).toHaveURL(/\/app$/);
  await page.goBack();
  await expect(offer).toBeVisible();

  expect(await sessionUsername(page)).toBe(name);
});

test('a fresh session makes no refresh call, and neither does a visitor', async ({
  page,
}) => {
  const calls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/auth/get-session')
      calls.push(request.url());
  });
  // A refresh is made from a mount effect, so each page is checked once its
  // effects have run, not once the network (avatars included) goes idle.
  await page.goto('/');
  await effectsRan(page);
  await signUpMember(page.request);
  await page.goto('/');
  await effectsRan(page);
  await page.goto('/app');
  await effectsRan(page);
  // A refresh is due only a day after the last extension, so a browser
  // spends the rate-limited endpoint about once a day, not per page load.
  expect(calls).toEqual([]);
});

test('a visitor can reach the topbar logo and Sign in', async ({ page }) => {
  const topbar = await watchTopbarLinks(page, ['Offense Demo home', 'Sign in']);
  await page.goto('/');
  const signIn = page
    .getByRole('banner')
    .getByRole('link', { name: 'Sign in' });
  await expect(signIn).toBeVisible();
  const { covered, inspected } = await topbar.settle();
  expect(Object.keys(inspected).sort()).toEqual([
    'Offense Demo home',
    'Sign in',
  ]);
  expect(covered).toEqual([]);
  await signIn.click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
