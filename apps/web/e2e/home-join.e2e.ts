import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { freshEmail, origin, resetRateLimits } from './support/accounts';
import { expectFocusOn } from './support/focus';
import { resendByKeyboard } from './support/forms';
import { effectsRan } from './support/hydration';

// WAIT-2.1: the home page's join is the sign-in link request, so for the same
// request the home page answers exactly what /sign-in answers, including where
// keyboard focus lands. Each scenario runs once per surface and the two
// observations must be equal.
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

const surfaces = ['/', '/sign-in'] as const;

const submit = async (page: Page, path: string, email: string) => {
  await page.goto(path);
  await effectsRan(page);
  const field = page.getByLabel('Email');
  await expect(field).toBeVisible();
  await field.focus();
  await page.keyboard.type(email);
  await page.keyboard.press('Enter');
};

const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.id ?? '');

/** What the visitor is shown once the answer has settled. */
const answerOf = async (page: Page, heading: RegExp | string) => {
  const target =
    typeof heading === 'string'
      ? page.getByText(heading)
      : page.getByRole('heading', { name: heading });
  await expect(target).toBeVisible();
  return {
    text: (await target.first().innerText()).trim(),
    focus: await focused(page),
  };
};

test('a sent link answers the check-inbox step with the same focus as /sign-in', async ({
  page,
}) => {
  const answers = [];
  for (const path of surfaces) {
    await resetRateLimits(page.request);
    await submit(page, path, freshEmail());
    await expectFocusOn(page, 'h1', 'check-inbox-heading');
    answers.push(await answerOf(page, /check your inbox/i));
  }
  expect(answers[0]).toEqual(answers[1]);
});

test('a refused link answers the same notice and returns focus to the email field', async ({
  page,
}) => {
  const answers = [];
  for (const path of surfaces) {
    await resetRateLimits(page.request);
    const email = freshEmail();
    for (let sent = 0; sent < 3; sent += 1)
      expect(
        (
          await page.request.post('/api/auth/sign-in/magic-link', {
            headers: { origin },
            data: { email, callbackURL: '/' },
          })
        ).status(),
      ).toBe(200);
    await submit(page, path, email);
    await expectFocusOn(page, 'input', 'sign-in-email');
    answers.push(await answerOf(page, 'Too many sign-in requests right now.'));
  }
  expect(answers[0]).toEqual(answers[1]);
});

test('a refused resend answers the same notice and returns focus to the email field', async ({
  page,
}) => {
  const answers = [];
  for (const path of surfaces) {
    await resetRateLimits(page.request);
    const email = freshEmail();
    for (let sent = 0; sent < 2; sent += 1)
      await page.request.post('/api/auth/sign-in/magic-link', {
        headers: { origin },
        data: { email, callbackURL: '/' },
      });
    await page.clock.install();
    await submit(page, path, email);
    await expectFocusOn(page, 'h1', 'check-inbox-heading');
    await resendByKeyboard(page);
    await expectFocusOn(page, 'input', 'sign-in-email');
    answers.push(await answerOf(page, 'Too many sign-in requests right now.'));
  }
  expect(answers[0]).toEqual(answers[1]);
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('the home page posts the email and renders the inbox step, never putting it in the URL', async ({
    page,
  }) => {
    const email = freshEmail();
    await page.goto('/');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(
      page.getByRole('heading', { name: /check your inbox/i }),
    ).toBeVisible();
    expect(page.url()).not.toContain(encodeURIComponent(email));
    expect(page.url()).not.toContain(email);
  });
  test('a refused link shows an alert naming a minute’s wait and passkey sign-in (AUTH-3.10.2)', async ({
    page,
  }) => {
    const email = freshEmail();
    for (let sent = 0; sent < 3; sent += 1)
      await page.request.post('/api/auth/sign-in/magic-link', {
        headers: { origin },
        data: { email, callbackURL: '/' },
      });
    await page.goto('/');
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Too many sign-in requests right now.');
    await expect(alert).toContainText('Wait a minute');
    await expect(alert).toContainText('sign in with a passkey');
  });
});
