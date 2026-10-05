import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { createId } from '@paralleldrive/cuid2';
import { resolveE2EOrigin, resolveE2EPorts } from '../../playwright.config';
import { hydrated } from './hydration';
import { enrollFromSettings, signInWithPasskey } from './webauthn';

/**
 * Real accounts for the browser suite. Every step goes through the production
 * handlers: request a link, read it from the mail capture, redeem it at
 * /auth/confirm, claim a username. Nothing is seeded and no session is
 * forged; the cookie lands in the calling browser context.
 */
const mailBase = `http://127.0.0.1:${resolveE2EPorts(process.env).mail}`;
export const origin = resolveE2EOrigin(process.env);

/** Collision-free test names: cuid2 is lowercase alphanumeric. */
export const uniqueName = (prefix: string) =>
  `${prefix}${createId().slice(0, 16)}`.slice(0, 30);
export const freshEmail = () => `${uniqueName('e2e')}@example.test`;

/** Rate limits are per client and the browser is one client. */
export const resetRateLimits = async (request: APIRequestContext) => {
  await request.post(`${mailBase}/reset`);
};

/** Polls the capture for the newest link mailed to this address. */
export async function emailedLink(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  let link: string | undefined;
  await expect(async () => {
    const response = await request.get(`${mailBase}/mails?to=${email}`);
    const mails = (await response.json()) as { text: string }[];
    expect(mails.length).toBeGreaterThan(0);
    link = mails.at(-1)?.text.match(/https:\/\/\S+/)?.[0];
    expect(link).toBeTruthy();
  }).toPass({ timeout: 10_000 });
  return link as string;
}

/**
 * Signs the context's browser in to a new account through the real
 * handlers, stopping before the username claim: the account is provisional
 * and onboarding is next. Use `context.request` (or `page.request`) so the
 * session cookie is shared. Returns the redemption response too, so a
 * caller that needs to inspect it (its Set-Cookie attributes, for one)
 * never has to duplicate the request-link-then-confirm flow.
 */
export async function signUpProvisionalResponse(request: APIRequestContext) {
  await resetRateLimits(request);
  const email = freshEmail();
  const requested = await request.post('/api/auth/sign-in/magic-link', {
    headers: { origin },
    data: { email, callbackURL: '/app' },
  });
  expect(requested.status()).toBe(200);
  const token = new URL(await emailedLink(request, email)).searchParams.get(
    'token',
  );
  const confirmed = await request.post('/auth/confirm', {
    headers: { origin },
    form: { token: token ?? '', callbackURL: '/app' },
    maxRedirects: 0,
  });
  expect(confirmed.status()).toBe(303);
  return { email, confirmed };
}

/** As `signUpProvisionalResponse`, for callers that only need the email. */
export async function signUpProvisional(request: APIRequestContext) {
  const { email } = await signUpProvisionalResponse(request);
  return { email };
}

/** Signs the context's browser in as a new member with a claimed username. */
export async function signUpMember(request: APIRequestContext) {
  const { email } = await signUpProvisional(request);
  const username = uniqueName('member');
  const claimed = await request.post('/api/account/username', {
    headers: { origin },
    data: { username },
  });
  expect(claimed.status()).toBe(201);
  return { email, username };
}

/** Requests a sign-in link from the /sign-in form the page is on. */
export async function requestSignInLink(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('heading', { name: /check your inbox/i }),
  ).toBeVisible();
}

/** Opens a sign-in link and takes the confirmation tap. */
export async function confirmSignIn(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole('button', { name: 'Sign in to Offense Demo' }).click();
}

/** A brand-new address signed in through the real form, left at onboarding. */
export async function reachOnboarding(page: Page, request: APIRequestContext) {
  const email = freshEmail();
  await page.goto('/sign-in');
  await requestSignInLink(page, email);
  await confirmSignIn(page, await emailedLink(request, email));
  await expect(page).toHaveURL(/\/onboarding\/username/);
  return email;
}

/** Enrolls a passkey from account security settings on the page's device. */
export async function addPasskeyFromSettings(page: Page) {
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
  await enrollFromSettings(page);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(1);
}

/**
 * Signs out, then back in with the device's passkey, proving a listed
 * credential really authenticates: lands on the validated /app.
 */
export async function passkeySignInAfterSignOut(page: Page) {
  // The button's own handler navigates to /sign-in once sign-out resolves;
  // wait for that navigation instead of racing it with another. Hardening
  // (ISSUE-212): it is a script button, so wait for hydration first.
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await hydrated(signOut);
  await signOut.click();
  await page.waitForURL(/\/sign-in$/);
  await page.goto('/sign-in?next=%2Fapp');
  await signInWithPasskey(page);
  await expect(page).toHaveURL(/\/app$/);
}

/** The username the page's own session carries, read from the server. */
export const sessionUsername = async (page: Page) => {
  const session = await page.request.get('/api/auth/get-session');
  return ((await session.json()) as { user: { username: string } }).user
    .username;
};
