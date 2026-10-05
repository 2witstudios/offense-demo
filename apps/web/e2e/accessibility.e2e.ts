import { expect, test } from './support/fixtures';
import {
  freshEmail,
  resetRateLimits,
  signUpMember,
  reachOnboarding,
  requestSignInLink,
} from './support/accounts';
import { assertNoSeriousFindings } from './support/axe';
import {
  reachExpiredLink,
  reachRetryState,
  reachSentState,
  requestConfirmLink,
} from './support/confirm-page';
import { gotoWithTheme } from './support/theme';

/**
 * Automated accessibility coverage for every authentication and security
 * screen (AUTH-6.6), the passkey offer in both themes (ISSUE-77), plus the
 * signed-in product shell's home and settings routes in both themes
 * (ISSUE-10): zero serious/critical axe findings and usability at 200%
 * zoom; keyboard-only use, visible focus and live-region announcements are
 * in accessibility-keyboard.e2e.ts. Chromium/Firefox/WebKit desktop and mobile projects all run
 * this file (only passkey-lifecycle.e2e.ts is Chromium-only), so narrow
 * (compact) layout usability is exercised by the mobile projects without a
 * separate test; only the theme axis needs its own explicit cases here.
 */
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test('sign-in (idle state) has no serious or critical accessibility findings', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await assertNoSeriousFindings(page);
});

test('sign-in (pending confirmation state) has no serious or critical accessibility findings', async ({
  page,
}) => {
  await page.goto('/sign-in');
  await requestSignInLink(page, freshEmail());
  await assertNoSeriousFindings(page);
});

test('username onboarding has no serious or critical accessibility findings', async ({
  page,
  request,
}) => {
  await reachOnboarding(page, request);
  await assertNoSeriousFindings(page);

  // A recoverable validation error is also part of this screen's contract.
  await page.getByLabel('Username').fill('no spaces allowed');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('#username-notice')).toBeVisible();
  await assertNoSeriousFindings(page);
});

test('account security settings has no serious or critical accessibility findings', async ({
  page,
}) => {
  await signUpMember(page.request);
  await page.goto('/settings/security');
  await assertNoSeriousFindings(page);
});

test('AUTH-4.7 confirm state has no serious or critical accessibility findings in dark or light', async ({
  page,
  request,
}) => {
  const { link } = await requestConfirmLink(page, request);
  for (const theme of ['dark', 'light'] as const) {
    await gotoWithTheme(page, link, theme);
    await expect(
      page.getByRole('button', { name: 'Sign in to Offense Demo' }),
    ).toBeVisible();
    await assertNoSeriousFindings(page);
  }
});

test('AUTH-4.7 expired state has no serious or critical accessibility findings in dark or light', async ({
  page,
  request,
}) => {
  for (const theme of ['dark', 'light'] as const) {
    await reachExpiredLink(page, request, theme);
    await assertNoSeriousFindings(page);
  }
});

test('AUTH-4.7 "too many attempts" retry state has no serious or critical accessibility findings in dark or light', async ({
  page,
  request,
}) => {
  test.slow();
  for (const theme of ['dark', 'light'] as const) {
    await reachRetryState(page, request, theme);
    await assertNoSeriousFindings(page);
    await resetRateLimits(request);
  }
});

test('AUTH-4.7 "check your inbox" sent state has no serious or critical accessibility findings in dark or light', async ({
  page,
  request,
}) => {
  for (const theme of ['dark', 'light'] as const) {
    // Two magic-link requests per iteration (the initial link, then the
    // resend): reset between themes so the second iteration never spends
    // the first's share of the 3-per-60s client/recipient ceiling.
    await resetRateLimits(request);
    await reachSentState(page, request, theme);
    await assertNoSeriousFindings(page);
  }
});

test('AUTH-4.7 email-change confirm page has no serious or critical accessibility findings in dark or light', async ({
  page,
}) => {
  for (const theme of ['dark', 'light'] as const) {
    await gotoWithTheme(
      page,
      `/auth/confirm-email?token=${'a'.repeat(43)}`,
      theme,
    );
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await assertNoSeriousFindings(page);

    await gotoWithTheme(page, '/auth/confirm-email?token=too-short', theme);
    await expect(
      page.getByRole('heading', { name: /can no longer be used/i }),
    ).toBeVisible();
    await assertNoSeriousFindings(page);
  }
});

test('sign-in stays usable with no horizontal overflow at 200% effective zoom', async ({
  page,
}) => {
  // Playwright has no native browser-zoom control; halving the viewport
  // while keeping the same page content approximates a 200% zoom reflow
  // (twice as many CSS pixels per visible inch), the standard technique for
  // testing zoom-driven reflow without a real browser UI.
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto('/sign-in');
  const overflowsHorizontally = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(overflowsHorizontally).toBe(false);
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
});

test('account security settings stays usable with no horizontal overflow at 200% effective zoom', async ({
  page,
}) => {
  await signUpMember(page.request);
  await page.setViewportSize({ width: 640, height: 400 });
  await page.goto('/settings/security');
  const overflowsHorizontally = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );
  expect(overflowsHorizontally).toBe(false);
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
});

test('home has no serious or critical accessibility findings in dark or light', async ({
  page,
}) => {
  await gotoWithTheme(page, '/', 'dark');
  await assertNoSeriousFindings(page);

  await gotoWithTheme(page, '/', 'light');
  await assertNoSeriousFindings(page);
});

test('settings has no serious or critical accessibility findings in dark or light', async ({
  page,
}) => {
  await signUpMember(page.request);

  await gotoWithTheme(page, '/settings', 'dark');
  await assertNoSeriousFindings(page);

  await gotoWithTheme(page, '/settings', 'light');
  await assertNoSeriousFindings(page);
});

test('the confirm sign-in page stays usable with no horizontal overflow at 320 px and 200% effective zoom', async ({
  page,
  request,
}) => {
  const { link } = await requestConfirmLink(page, request);
  for (const width of [320, 640]) {
    await page.setViewportSize({ width, height: 480 });
    await page.goto(link);
    const overflowsHorizontally = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(overflowsHorizontally).toBe(false);
    await expect(
      page.getByRole('button', { name: 'Sign in to Offense Demo' }),
    ).toBeVisible();
  }
});

test('the passkey offer has no serious or critical accessibility findings in dark or light', async ({
  page,
}) => {
  await signUpMember(page.request);

  await gotoWithTheme(page, '/onboarding/passkey?next=%2Fapp', 'dark');
  await expect(
    page.getByRole('heading', { name: /next time, one tap/i }),
  ).toBeVisible();
  await assertNoSeriousFindings(page);

  await gotoWithTheme(page, '/onboarding/passkey?next=%2Fapp', 'light');
  await assertNoSeriousFindings(page);
});

test('the axe check refuses a page with a frame, since its legacy mode would skip it (ISSUE-198)', async ({
  page,
}) => {
  await page.goto('/sign-in');
  // A titled frame: axe itself finds nothing wrong with it, so only the
  // guard stands between it and a scan that quietly covers less.
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.title = 'Embedded content';
    document.body.append(frame);
  });
  await expect(assertNoSeriousFindings(page)).rejects.toThrow(
    /drop setLegacyMode/,
  );
});
