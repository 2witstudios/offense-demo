import { type Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import {
  emailedLink,
  freshEmail,
  confirmSignIn,
  origin,
  requestSignInLink,
  resetRateLimits,
  signUpMember,
  signUpProvisional,
  uniqueName,
  sessionUsername,
} from './support/accounts';
import { reachSentState, requestConfirmLink } from './support/confirm-page';
import { changeEmail, claimUsername, declineByKeyboard } from './support/forms';

/**
 * Every mutating form works with JavaScript off (docs/development/
 * ui-conventions.md). These contexts run no script at all, inline or
 * bundled, so a page that only script can reveal, or a form that only
 * script can submit, fails here.
 */
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  /** Form values must never reach the address bar, history or referrers. */
  const expectNotInUrl = (page: Page, value: string) => {
    expect(page.url()).not.toContain(value);
    expect(page.url()).not.toContain(encodeURIComponent(value));
  };

  test('sign-in emails a link through a POST and shows the inbox step', async ({
    page,
    request,
  }) => {
    const email = freshEmail();
    await page.goto('/sign-in?next=%2Fapp');
    await requestSignInLink(page, email);
    await expect(page.getByText(email)).toBeVisible();
    expectNotInUrl(page, email);

    // The emailed link is real: it finishes sign-in on this browser, still
    // with no script, and a new account goes on to onboarding.
    await confirmSignIn(page, await emailedLink(request, email));
    await expect(page).toHaveURL(/\/onboarding\/username\?next=(\/|%2F)app$/);
  });

  test('the username form renders, refuses and claims', async ({ page }) => {
    await signUpProvisional(page.request);
    await page.goto('/onboarding/username?next=%2Fapp');

    // A refusal comes back from the server with the name as typed.
    await claimUsername(page, 'no spaces allowed');
    await expect(page.locator('#username-notice')).toContainText(
      'That username will not work',
    );
    await expect(page.getByLabel('Username')).toHaveValue('no spaces allowed');
    expectNotInUrl(page, 'no spaces allowed');

    const name = uniqueName('noscript');
    await claimUsername(page, name);
    await expect(
      page.getByRole('heading', { name: /next time, one tap/i }),
    ).toBeVisible();
    expectNotInUrl(page, name);
    // ISSUE-75: the decline choices are real buttons plain Tab reaches, and
    // Enter activates them, with no script at all — not only a click.
    await declineByKeyboard(page, 'Not now');

    expect(await sessionUsername(page)).toBe(name);
  });

  test('an email change starts through a POST and mails the address on file', async ({
    page,
    request,
  }) => {
    const { email } = await signUpMember(page.request);
    await page.goto('/settings/security');
    const next = freshEmail();
    await changeEmail(page, next);
    await expect(page.locator('#email-change-notice')).toContainText(
      /approve this change/i,
    );
    expectNotInUrl(page, next);
    // The approval goes to the address on file, never the new one.
    expect(await emailedLink(request, email)).toContain('/auth/confirm-email');
  });

  test('AUTH-4.7: an expired link resends and ends on "check your inbox", with no JavaScript', async ({
    page,
    request,
  }) => {
    // A redeemed link revisited looks the same as an expired one to the
    // person: GET never redeems, so the page still renders; only the POST
    // (the button) discovers the token is spent.
    const email = await reachSentState(page, request);
    expectNotInUrl(page, email);
  });

  test('AUTH-4.7: a real double submit of the same confirm link ends on a usable page, with no JavaScript', async ({
    page,
    request,
  }) => {
    const { link } = await requestConfirmLink(page, request);
    const linkUrl = new URL(link);
    const formBody = {
      token: linkUrl.searchParams.get('token') ?? '',
      callbackURL: linkUrl.searchParams.get('callbackURL') ?? '/app',
    };
    // Two overlapping submissions of the very same token, fired together
    // rather than sequentially: the double submit a slow network or an
    // eager double-click produces, with no script to debounce the second
    // click. `page.request` shares the page's cookie jar, so whichever
    // submission actually signs in leaves its session cookie behind for
    // the page navigations below.
    const post = () =>
      page.request.post('/auth/confirm', {
        headers: { origin },
        form: formBody,
        maxRedirects: 0,
      });
    const [first, second] = await Promise.all([post(), post()]);

    const signedIn = [first, second].filter(
      (response) => response.headers()['set-cookie'],
    );
    // The redemption is atomic: exactly one submission signs in, whichever
    // arrived first; the other finds the token already spent.
    expect(signedIn.length).toBe(1);
    for (const response of [first, second]) expect(response.status()).toBe(303);

    // The winner's own redirect target is a real, working page.
    const winnerLocation = signedIn[0]?.headers()['location'] ?? '/app';
    await page.goto(winnerLocation);
    await expect(page).not.toHaveURL(/\/sign-in/);

    // The loser's redirect lands on the expired state, itself still usable:
    // the resend form and "Continue to Offense Demo" both work from here.
    const loser = [first, second].find((response) => response !== signedIn[0]);
    await page.goto(loser?.headers()['location'] ?? '/auth/confirm');
    await expect(
      page.getByRole('heading', { name: /can no longer be used/i }),
    ).toBeVisible();
    const continueLink = page.getByRole('link', {
      name: /already signed in\? continue to offense-demo/i,
    });
    await continueLink.click();
    await expect(page).not.toHaveURL(/\/sign-in/);
  });
});
