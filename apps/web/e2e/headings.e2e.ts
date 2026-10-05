import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import {
  reachOnboarding,
  resetRateLimits,
  signUpMember,
} from './support/accounts';
import {
  reachExpiredLink,
  reachRetryState,
  reachSentState,
  requestConfirmLink,
} from './support/confirm-page';

/**
 * ISSUE-216: axe reports a missing h1 only as a moderate finding, which
 * `assertNoSeriousFindings` does not gate, so each auth and security screen
 * asserts its single h1 directly: exactly one, and it names the page.
 */
const expectOneH1 = async (page: Page, name: RegExp) => {
  const headings = page.getByRole('heading', { level: 1 });
  await expect(headings).toHaveCount(1);
  await expect(headings).toHaveText(name);
};

/** The screens whose h1 is in the server-rendered HTML (no script needed). */
const expectServerRenderedH1s = async (page: Page) => {
  await page.goto(`/auth/confirm-email?token=${'a'.repeat(43)}`);
  await expectOneH1(page, /confirm this email change/i);
  await page.goto('/auth/confirm-email?token=too-short');
  await expectOneH1(page, /can no longer be used/i);
  await signUpMember(page.request);
  await page.goto('/onboarding/passkey?next=%2Fapp');
  await expectOneH1(page, /next time, one tap/i);
  await page.goto('/settings/security');
  await expectOneH1(page, /account security/i);
};

test('every auth and security screen has exactly one h1 naming the page (ISSUE-216)', async ({
  page,
  request,
}) => {
  test.slow();
  await page.goto('/sign-in');
  await expectOneH1(page, /take the floor/i);

  // Each state requests its own magic link: reset between them so none
  // spends another's share of the per-client mail ceiling.
  const { link } = await requestConfirmLink(page, request);
  await page.goto(link);
  await expectOneH1(page, /finish signing in/i);

  // The retry state reuses the confirm view with a notice.
  await resetRateLimits(request);
  await reachRetryState(page, request);
  await expectOneH1(page, /finish signing in/i);

  await resetRateLimits(request);
  await reachSentState(page, request);
  await expectOneH1(page, /check your inbox/i);

  await resetRateLimits(request);
  await reachExpiredLink(page, request);
  await expectOneH1(page, /link can no longer be used/i);

  await expectServerRenderedH1s(page);
});

test('onboarding username has exactly one h1 naming the page (ISSUE-216)', async ({
  page,
  request,
}) => {
  await reachOnboarding(page, request);
  await expectOneH1(page, /choose your username/i);
});

test.describe('with JavaScript off (ISSUE-216)', () => {
  test.use({ javaScriptEnabled: false });

  test('the server-rendered auth and security screens each have exactly one h1', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expectOneH1(page, /take the floor/i);
    await expectServerRenderedH1s(page);
  });
});
