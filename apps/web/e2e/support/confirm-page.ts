import { expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  confirmSignIn,
  emailedLink,
  freshEmail,
  origin,
  requestSignInLink,
} from './accounts';
import { gotoWithTheme, type Theme } from './theme';

/** Requests a real magic link through the /sign-in form. */
export async function requestConfirmLink(
  page: Page,
  request: APIRequestContext,
): Promise<{ readonly email: string; readonly link: string }> {
  const email = freshEmail();
  await page.goto('/sign-in');
  await requestSignInLink(page, email);
  const link = await emailedLink(request, email);
  return { email, link };
}

/**
 * A redeemed link revisited looks the same as an expired one to the person
 * (AUTH-4.7's expired state): sign up, redeem, clear the session, then
 * revisit (in the requested theme) and take the confirmation tap again.
 */
export async function reachExpiredLink(
  page: Page,
  request: APIRequestContext,
  theme: Theme = 'dark',
): Promise<string> {
  const { email, link } = await requestConfirmLink(page, request);
  await confirmSignIn(page, link);
  await page.context().clearCookies();
  await gotoWithTheme(page, link, theme);
  await page.getByRole('button', { name: 'Sign in to Offense Demo' }).click();
  await expect(
    page.getByRole('heading', { name: /can no longer be used/i }),
  ).toBeVisible();
  return email;
}

/** AUTH-4.7's "check your inbox" sent state, reached through a real resend. */
export async function reachSentState(
  page: Page,
  request: APIRequestContext,
  theme: Theme = 'dark',
): Promise<string> {
  const email = await reachExpiredLink(page, request, theme);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a new link' }).click();
  await expect(
    page.getByRole('heading', { name: /check your inbox/i }),
  ).toBeVisible();
  return email;
}

// A throwaway, well-shaped token (never the real one): `confirm.ts`'s
// `redeem()` only checks the shape locally before forwarding to Better
// Auth's `/magic-link/verify`, so this still spends that path's shared
// per-client bucket (`rate-limit.ts`'s `DEFAULT_RULE`, 100/60s) without
// ever touching a real account. The endpoint itself refuses direct
// external GETs (`handlers.ts`'s `DIRECT_REDEMPTION_BLOCKED_PATHS`), so
// this goes through the same same-origin POST hop a real double-click
// would.
const PROBE_TOKEN = 'e2eRateLimitProbeNotARealToken00';

/**
 * AUTH-4.7's "too many attempts" retry state, reached without exhausting a
 * real recipient or global ceiling: spending the redeem hop's shared
 * client+path bucket with a throwaway token first, then clicking the real
 * link's button, answers the same 429 a genuine burst would.
 */
export async function reachRetryState(
  page: Page,
  request: APIRequestContext,
  theme: Theme = 'dark',
): Promise<void> {
  const { link } = await requestConfirmLink(page, request);
  // A little over the 100/60s ceiling: margin against any probe that fails
  // to round-trip rather than land a 4xx (which still consumes the bucket).
  // One concurrent burst, the shape a real flood takes: the limiter consumes
  // atomically, so it counts the same as one-at-a-time probes, which cost
  // 5-8 s of a 30 s test on a loaded machine (ISSUE-204).
  await Promise.all(
    Array.from({ length: 110 }, () =>
      page.request.post('/auth/confirm', {
        headers: { origin },
        form: { token: PROBE_TOKEN, callbackURL: '/app' },
      }),
    ),
  );
  await gotoWithTheme(page, link, theme);
  await page.getByRole('button', { name: 'Sign in to Offense Demo' }).click();
  // `getByRole('alert')` also matches Next's own
  // `#__next-route-announcer__`; the notice is the one with real text.
  await expect(page.getByText(/too many attempts/i)).toBeVisible();
}
