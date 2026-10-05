import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import {
  freshEmail,
  resetRateLimits,
  signUpMember,
  signUpProvisional,
  uniqueName,
} from './support/accounts';
import { changeEmail, claimUsername, dropServerActions } from './support/forms';
import { effectsRan } from './support/hydration';

// ISSUE-94: with JavaScript on, a form's server action is a fetch the page
// makes. When that fetch fails in transport (the connection drops), the
// form shows its own unavailable notice with the typed value kept, never
// the root error screen.
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

const expectNoRootError = async (page: Page) =>
  expect(
    page.getByRole('heading', { name: 'Something went wrong' }),
  ).toHaveCount(0);

test('a sign-in link request lost in transport shows the unavailable notice with the address kept', async ({
  page,
}) => {
  const email = freshEmail();
  await page.goto('/sign-in?next=%2Fapp');
  await effectsRan(page);
  await dropServerActions(page);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByText('Sign-in is temporarily unavailable.'),
  ).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await expectNoRootError(page);
});

test('an email change lost in transport shows the unavailable notice beside the form', async ({
  page,
}) => {
  await signUpMember(page.request);
  await page.goto('/settings/security');
  await effectsRan(page);
  await dropServerActions(page);
  const next = freshEmail();
  await changeEmail(page, next);
  await expect(page.locator('#email-change-notice')).toContainText(
    'Please try again.',
  );
  await expect(page.getByLabel('New email address')).toHaveValue(next);
  await expectNoRootError(page);
});

test('a username claim lost in transport shows the unavailable notice with the name kept', async ({
  page,
}) => {
  await signUpProvisional(page.request);
  await page.goto('/onboarding/username?next=%2Fapp');
  await effectsRan(page);
  await dropServerActions(page);
  const name = uniqueName('offline');
  await claimUsername(page, name);
  await expect(page.locator('#username-notice')).toContainText(
    'We could not save your username.',
  );
  await expect(page.getByLabel('Username')).toHaveValue(name);
  await expectNoRootError(page);
});
