import { origin, resetRateLimits, signUpMember } from './support/accounts';
import { expect, openPage, test } from './support/fixtures';
import { addVirtualAuthenticator } from './support/webauthn';

/**
 * Passkey sign-in from browser autofill (conditional mediation), end to end
 * over the production build: autofill alone signs in, and the explicit
 * button still works while autofill is armed. Chromium's CDP virtual
 * authenticator answers a conditional request with its one discoverable
 * credential, standing in for the person picking it from the autofill list;
 * the Chromium projects run this file (playwright.config.ts).
 */
test.beforeEach(async ({ request }) => {
  await resetRateLimits(request);
});

test('a saved passkey signs in from autofill without the button', async ({
  page,
  browser,
}) => {
  // Enroll on one device, then carry the passkey to a fresh, signed-out
  // browser, so the only way the page can sign in is the autofill request.
  const enrolling = await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: origin,
  });
  const enrollPage = await openPage(enrolling, 'the enrolling browser');
  const device = await addVirtualAuthenticator(enrollPage);
  await signUpMember(enrollPage.request);
  await enrollPage.goto('/settings/security');
  await enrollPage.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(
    enrollPage.getByRole('button', { name: 'Rename' }),
  ).toBeVisible();
  const passkeys = await device.credentials();
  await enrolling.close();

  await addVirtualAuthenticator(page, passkeys);
  await page.goto('/sign-in?next=%2Fapp');
  await expect(page).toHaveURL(/\/app$/);
});

test('with passkey autofill armed, the explicit button still signs in', async ({
  page,
}) => {
  const { setPresence } = await addVirtualAuthenticator(page);
  await signUpMember(page.request);
  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();
  // Hold user presence so the armed autofill request stays pending: the
  // virtual authenticator would otherwise answer it, and a request sent while
  // presence is held never completes, even after presence returns.
  await setPresence(false);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  // Signing out lands on /sign-in, which arms autofill too; wait for the
  // destination page's own request, not that one.
  const armed = page.waitForResponse(
    (response) =>
      response.url().includes('/passkey/generate-authenticate-options') &&
      (response.request().headers()['referer'] ?? '').includes('next=%2Fapp'),
  );
  await page.goto('/sign-in?next=%2Fapp');
  await armed;
  // Release presence before the button's options reach the page, so its
  // request is sent with presence available, and keep its challenge. Only a
  // request made after the click is the button's.
  let clicked = false;
  let buttonChallenge = '';
  await page.route(
    '**/api/auth/passkey/generate-authenticate-options',
    async (route) => {
      if (!clicked) return route.continue();
      clicked = false;
      await setPresence(true);
      const response = await route.fetch();
      buttonChallenge = ((await response.json()) as { challenge: string })
        .challenge;
      await route.fulfill({ response });
    },
  );
  const verified = page.waitForRequest((request) =>
    request.url().includes('/passkey/verify-authentication'),
  );
  clicked = true;
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  const assertion = (await verified).postDataJSON() as {
    response: { response: { clientDataJSON: string } };
  };
  const clientData = JSON.parse(
    Buffer.from(
      assertion.response.response.clientDataJSON,
      'base64url',
    ).toString('utf8'),
  ) as { challenge: string };
  // The signed challenge is the button's, not the held autofill request's.
  expect(clientData.challenge).toBe(buttonChallenge);
  await expect(page).toHaveURL(/\/app$/);
});
