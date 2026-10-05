import { expect, test } from './support/fixtures';

test.describe('shell chrome', () => {
  test('sidebar marks the active route and navigates from the shell', async ({
    page,
  }) => {
    await page.goto('/');
    const home = page.getByRole('link', { name: 'Home', exact: true });
    await expect(home).toHaveAttribute('aria-current', 'page');
    const app = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'App', exact: true });
    await expect(app).not.toHaveAttribute('aria-current', 'page');

    // App is a participant area: a visitor is sent to sign-in on the way.
    await app.click();
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
  });

  test('interactive controls carry accessible names', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.locator('header').getByRole('link', { name: 'Sign in' }),
    ).toBeVisible();
  });
});
