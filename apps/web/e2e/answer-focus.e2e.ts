import { type Locator, type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import {
  freshEmail,
  origin,
  resetRateLimits,
  signUpMember,
} from './support/accounts';
import { assertNoSeriousFindings } from './support/axe';
import { expectFocusOn, pressByKeyboard } from './support/focus';
import { dropServerActions, resendByKeyboard } from './support/forms';
import { effectsRan } from './support/hydration';
import {
  withPasskeyCapability,
  withoutPasskeyAutofill,
} from './support/webauthn';

// ISSUE-107: a form disables its field and button while its answer is on
// the way, and a disabled control loses focus. With JavaScript on, each
// answer (sent, refused, or unavailable after a transport failure) must
// hand keyboard focus back to the form's field, or to the next step's
// heading, never leave it on <body>. Every answer here is reached with the
// keyboard alone: focus the field, type, press Enter.
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

/** Types into `field` and submits with Enter, touching nothing else. */
const submitByKeyboard = async (field: Locator, value: string) => {
  // The page streams in behind the root loading boundary; a focus sent
  // before the reveal lands on the hidden copy (ISSUE-45).
  await expect(field).toBeVisible();
  await field.focus();
  await expect(field).toBeFocused();
  await field.page().keyboard.type(value);
  await field.page().keyboard.press('Enter');
};

const openSignIn = async (page: Page) => {
  await page.goto('/sign-in?next=%2Fapp');
  await effectsRan(page);
};

const openSecurity = async (page: Page) => {
  const account = await signUpMember(page.request);
  await page.goto('/settings/security');
  await effectsRan(page);
  return account;
};

test('a sent sign-in link moves focus to the inbox step heading', async ({
  page,
}) => {
  await openSignIn(page);
  await submitByKeyboard(page.getByLabel('Email'), freshEmail());
  await expect(
    page.getByRole('heading', { name: /check your inbox/i }),
  ).toBeVisible();
  await expectFocusOn(page, 'h1', 'check-inbox-heading');
  await assertNoSeriousFindings(page);
});

/** Sends `count` sign-in links to `email` through the API, off the page. */
const spendLinks = async (page: Page, email: string, count: number) => {
  for (let sent = 0; sent < count; sent += 1)
    expect(
      (
        await page.request.post('/api/auth/sign-in/magic-link', {
          headers: { origin },
          data: { email, callbackURL: '/app' },
        })
      ).status(),
    ).toBe(200);
};

/**
 * Sends a link from the form on a page whose clock is installed before it
 * loads, so the resend cooldown can be crossed without waiting a minute.
 */
const sendFromForm = async (page: Page, email: string) => {
  await page.clock.install();
  await openSignIn(page);
  await submitByKeyboard(page.getByLabel('Email'), email);
  await expectFocusOn(page, 'h1', 'check-inbox-heading');
};

test('a refused sign-in link returns focus to the email field', async ({
  page,
}) => {
  const email = freshEmail();
  // The recipient allowance is three links a minute: spend it, so the
  // form's request is the refused fourth.
  await spendLinks(page, email, 3);
  await openSignIn(page);
  await submitByKeyboard(page.getByLabel('Email'), email);
  await expect(
    page.getByText('Too many sign-in requests right now.'),
  ).toBeVisible();
  await expectFocusOn(page, 'input', 'sign-in-email');
  await assertNoSeriousFindings(page);
});

test('a sign-in link lost in transport returns focus to the email field', async ({
  page,
}) => {
  await openSignIn(page);
  await dropServerActions(page);
  await submitByKeyboard(page.getByLabel('Email'), freshEmail());
  await expect(
    page.getByText('Sign-in is temporarily unavailable.'),
  ).toBeVisible();
  await expectFocusOn(page, 'input', 'sign-in-email');
  await assertNoSeriousFindings(page);
});

test('a refused sign-in link resend returns focus to the email field', async ({
  page,
}) => {
  const email = freshEmail();
  // Two links through the API and the form's third spend the recipient's
  // allowance of three a minute, so the resend is the refused fourth.
  await spendLinks(page, email, 2);
  await sendFromForm(page, email);
  await resendByKeyboard(page);
  await expect(
    page.getByText('Too many sign-in requests right now.'),
  ).toBeVisible();
  await expectFocusOn(page, 'input', 'sign-in-email');
  await assertNoSeriousFindings(page);
});

test('a sign-in link resend lost in transport returns focus to the email field', async ({
  page,
}) => {
  await sendFromForm(page, freshEmail());
  await dropServerActions(page);
  await resendByKeyboard(page);
  await expect(
    page.getByText('Sign-in is temporarily unavailable.'),
  ).toBeVisible();
  await expectFocusOn(page, 'input', 'sign-in-email');
  await assertNoSeriousFindings(page);
});

// ISSUE-118: the passkey button is disabled while its ceremony runs, the
// same focus drop. A ceremony that ends without signing in hands focus
// back to the email field its notice points to. These two endings reach
// every engine; a cancelled ceremony needs Chromium's virtual
// authenticator (passkey-lifecycle.e2e.ts).
const passkeyButton = (page: Page) =>
  page.getByRole('button', { name: 'Sign in with a passkey' });

test('a passkey sign-in in a browser without passkeys returns focus to the email field', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'PublicKeyCredential');
  });
  await openSignIn(page);
  await pressByKeyboard(passkeyButton(page));
  await expect(
    page.getByText('This browser cannot use passkeys.'),
  ).toBeVisible();
  await expectFocusOn(page, 'input', 'sign-in-email');
  await assertNoSeriousFindings(page);
});

test('a failed passkey sign-in returns focus to the email field', async ({
  page,
}) => {
  await withPasskeyCapability(page);
  await withoutPasskeyAutofill(page);
  await openSignIn(page);
  const options = '**/api/auth/passkey/generate-authenticate-options*';
  await page.route(options, (route) => route.abort('internetdisconnected'));
  // The ceremony fails at its server exchange on every engine, never at
  // the browser's capability check.
  const exchangeFailed = page.waitForEvent('requestfailed', (request) =>
    request.url().includes('/api/auth/passkey/generate-authenticate-options'),
  );
  await pressByKeyboard(passkeyButton(page));
  await exchangeFailed;
  await expect(
    page.getByText('We could not sign you in with a passkey.'),
  ).toBeVisible();
  await expectFocusOn(page, 'input', 'sign-in-email');
  await assertNoSeriousFindings(page);
});

test('an accepted email change returns focus to the new-address field', async ({
  page,
}) => {
  await openSecurity(page);
  await submitByKeyboard(page.getByLabel('New email address'), freshEmail());
  await expect(page.locator('#email-change-notice')).toContainText(
    /approve this change/i,
  );
  await expectFocusOn(page, 'input', 'new-email');
  await assertNoSeriousFindings(page);
});

test('a refused email change returns focus to the new-address field', async ({
  page,
}) => {
  const { email } = await openSecurity(page);
  // Moving to the address already on file is refused as invalid.
  await submitByKeyboard(page.getByLabel('New email address'), email);
  await expect(page.locator('#email-change-notice')).toContainText(
    'That was not a valid request.',
  );
  await expectFocusOn(page, 'input', 'new-email');
  await assertNoSeriousFindings(page);
});

test('an email change lost in transport returns focus to the new-address field', async ({
  page,
}) => {
  await openSecurity(page);
  await dropServerActions(page);
  await submitByKeyboard(page.getByLabel('New email address'), freshEmail());
  await expect(page.locator('#email-change-notice')).toContainText(
    'Please try again.',
  );
  await expectFocusOn(page, 'input', 'new-email');
  await assertNoSeriousFindings(page);
});
