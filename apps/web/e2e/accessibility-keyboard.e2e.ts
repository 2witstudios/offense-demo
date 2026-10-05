import { expect, test } from './support/fixtures';
import {
  freshEmail,
  reachOnboarding,
  resetRateLimits,
  signUpMember,
  uniqueName,
} from './support/accounts';
import { changeEmail, declineByKeyboard } from './support/forms';

/**
 * Keyboard-only use, visible focus and live-region announcements on the
 * authentication and security screens (AUTH-6.6), split from
 * accessibility.e2e.ts's axe and zoom coverage. Every desktop and mobile
 * engine project runs this file (AUTH_JOURNEY_SPECS).
 */
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test('username onboarding is fully usable by keyboard alone, with visible focus', async ({
  page,
  request,
}) => {
  await reachOnboarding(page, request);

  // The shell streams in behind the root loading boundary and is revealed
  // a moment later; focus the field only once it is the visible one.
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.getByLabel('Username').focus();
  await expect(page.getByLabel('Username')).toBeFocused();
  await page.keyboard.type(uniqueName('kbd'));
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: /next time, one tap/i }),
  ).toBeVisible();
  // ISSUE-75: both decline choices are real buttons, so plain Tab reaches
  // them in every engine (WebKit used to skip links on Tab, needing
  // Option+Tab).
  await declineByKeyboard(page, 'Not now');
});

test('keyboard focus is visible on every sign-in control, not only present in the DOM (ISSUE-167)', async ({
  page,
}) => {
  // `toBeFocused()` elsewhere in this suite proves DOM focus state; it
  // never proves a sighted keyboard user can see where focus is (WCAG
  // 2.4.7). Each control is reached with Tab (keyboard modality, so
  // :focus-visible applies) and its rendered indicator compared with the
  // same control unfocused: a ring that looks the same both ways is none.
  await page.goto('/sign-in');
  await expect(page.getByLabel('Email')).toBeVisible();
  const checked: string[] = [];
  const invisible: string[] = [];
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    const control = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body)
        return null;
      const indicator = () => {
        const style = getComputedStyle(element);
        return `${style.outlineStyle} ${style.outlineWidth} ${style.boxShadow}`;
      };
      const focused = indicator();
      element.blur();
      const resting = indicator();
      element.focus();
      const name =
        element.getAttribute('aria-label') ??
        (element.textContent?.trim() || element.getAttribute('name') || '') +
          ` <${element.tagName.toLowerCase()}>`;
      return { name, visible: focused !== resting };
    });
    if (!control || checked.includes(control.name)) continue;
    checked.push(control.name);
    if (!control.visible) invisible.push(control.name);
  }
  expect(checked.length).toBeGreaterThanOrEqual(2);
  expect(invisible).toEqual([]);
});

test('the shared-computer decline choice is reachable with plain Tab in every engine', async ({
  page,
  request,
}) => {
  await reachOnboarding(page, request);
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.getByLabel('Username').focus();
  await page.keyboard.type(uniqueName('kbd2'));
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: /next time, one tap/i }),
  ).toBeVisible();
  await declineByKeyboard(page, 'This is a shared computer');
});

test('account security settings is operable by keyboard alone', async ({
  page,
}) => {
  await signUpMember(page.request);
  await page.goto('/settings/security');

  const newEmail = freshEmail();
  // ISSUE-45: the settings page streams in behind the root loading boundary
  // and React reveals it a moment later; a focus sent before that lands on
  // the still-hidden copy and is lost. Focus the field once it is visible.
  await expect(page.getByLabel('New email address')).toBeVisible();
  await page.getByLabel('New email address').focus();
  await expect(page.getByLabel('New email address')).toBeFocused();
  await page.keyboard.type(newEmail);
  await page.keyboard.press('Enter');
  await expect(page.locator('#email-change-notice')).toContainText(
    /approve this change/i,
  );
});

test('feedback regions announce updates through an accessible live region', async ({
  page,
}) => {
  await signUpMember(page.request);
  await page.goto('/settings/security');
  await changeEmail(page, freshEmail());
  const notice = page.locator('#email-change-notice');
  await expect(notice).toContainText(/approve this change/i);
  // `role="status"` implies an accessible-name-only live region announcement
  // (aria-live: polite) without a redundant explicit attribute.
  await expect(notice).toHaveAttribute('role', 'status');
});
