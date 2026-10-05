import { type Page } from '@playwright/test';
import { expect, openPage, test } from './support/fixtures';
import { signUpMember } from './support/accounts';
import { hydrated } from './support/hydration';

const DARK_BACKGROUND = 'rgb(15, 17, 23)';
const LIGHT_BACKGROUND = 'rgb(245, 246, 248)';

const backgroundOf = (page: Page) =>
  page
    .locator('body')
    .evaluate((body) => getComputedStyle(body).backgroundColor);

/**
 * Collects console errors, page errors, and CSP violations for the whole
 * test, switches included (view transitions must not trip the policy).
 */
const watchForProblems = async (page: Page) => {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // No favicon ships yet; headed/branded Chromium requests it and 404s.
    const source = message.location().url;
    if (URL.canParse(source) && new URL(source).pathname === '/favicon.ico')
      return;
    problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  await page.addInitScript(() => {
    const seen: string[] = [];
    Reflect.set(window, '__cspViolations', seen);
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return async () => {
    const violations = await page.evaluate(
      () => Reflect.get(window, '__cspViolations') as string[],
    );
    expect({ violations, problems }).toEqual({ violations: [], problems: [] });
  };
};

/**
 * Waits for the switcher to hydrate: a click on the inert server-rendered
 * radio would do nothing.
 */
const hydratedSwitcher = async (page: Page) => {
  const group = page.getByRole('radiogroup', { name: 'Theme' });
  await hydrated(group.getByRole('radio').first());
  return group;
};

const openSettings = async (page: Page) => {
  const response = await page.goto('/settings');
  const group = await hydratedSwitcher(page);
  return { html: (await response?.text()) ?? '', group };
};

/** Every theme-color meta in the document, as `media → content`. */
const themeColors = (page: Page) =>
  page
    .locator('meta[name="theme-color"]')
    .evaluateAll((metas) =>
      metas.map(
        (meta) =>
          `${meta.getAttribute('media')} → ${meta.getAttribute('content')}`,
      ),
    );

const settingsLink = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' });

const LIGHT_CHROME = [
  '(prefers-color-scheme: light) → #f5f6f8',
  '(prefers-color-scheme: dark) → #f5f6f8',
];

const servedTheme = (html: string) =>
  /<html\b[^>]*\sdata-theme="([^"]*)"/.exec(html)?.[1];

test.describe('theme preference', () => {
  // The switcher lives in Settings, which needs an account (AUTH-4.5).
  test.beforeEach(async ({ context }) => {
    await signUpMember(context.request);
  });

  test('serves dark to a first-time visitor', async ({ page }) => {
    const verifyClean = await watchForProblems(page);
    const { html, group } = await openSettings(page);

    expect(servedTheme(html)).toBe('dark');
    await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(await backgroundOf(page)).toBe(DARK_BACKGROUND);
    await verifyClean();
  });

  test('a chosen theme applies at once and is served on reload', async ({
    page,
  }) => {
    const verifyClean = await watchForProblems(page);
    const { group } = await openSettings(page);

    await group.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(group.getByRole('radio', { name: 'Light' })).toBeChecked();
    await expect.poll(() => backgroundOf(page)).toBe(LIGHT_BACKGROUND);
    await expect.poll(() => themeColors(page)).toEqual(LIGHT_CHROME);

    // No flash: the served HTML already carries the choice, before any JS.
    const reloaded = await page.reload();
    expect(servedTheme((await reloaded?.text()) ?? '')).toBe('light');
    await expect.poll(() => backgroundOf(page)).toBe(LIGHT_BACKGROUND);
    await expect.poll(() => themeColors(page)).toEqual(LIGHT_CHROME);
    await verifyClean();
  });

  test('browser chrome keeps the choice across client navigations', async ({
    page,
  }) => {
    const verifyClean = await watchForProblems(page);
    await page.goto('/');
    await settingsLink(page).click();
    await expect(page).toHaveURL(/\/settings$/);
    const group = await hydratedSwitcher(page);

    await group.getByRole('radio', { name: 'Light' }).click();
    await expect.poll(() => themeColors(page)).toEqual(LIGHT_CHROME);

    // Back re-renders the cached home page; forward is a fresh client
    // navigation. Neither may bring back the pre-switch chrome color.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => themeColors(page)).toEqual(LIGHT_CHROME);
    await settingsLink(page).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect.poll(() => themeColors(page)).toEqual(LIGHT_CHROME);
    await verifyClean();
  });

  test('system follows the OS scheme live', async ({ page }) => {
    const verifyClean = await watchForProblems(page);
    await page.emulateMedia({ colorScheme: 'light' });
    const { group } = await openSettings(page);

    await group.getByRole('radio', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
    await expect.poll(() => backgroundOf(page)).toBe(LIGHT_BACKGROUND);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => backgroundOf(page)).toBe(DARK_BACKGROUND);
    await verifyClean();
  });

  test('a tab shown again catches up with the saved preference', async ({
    page,
    context,
    baseURL,
  }) => {
    const verifyClean = await watchForProblems(page);
    const { group } = await openSettings(page);
    const saveTheme = (value: string) =>
      context.addCookies([
        { name: 'offense-demo-theme', value, url: baseURL ?? page.url() },
      ]);

    // Another tab saved light while this one was hidden and missed the
    // announcement; becoming visible again re-reads the cookie.
    await saveTheme('light');
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(group.getByRole('radio', { name: 'Light' })).toBeChecked();
    await expect.poll(() => themeColors(page)).toEqual(LIGHT_CHROME);

    // Restored from the back/forward cache: pageshow re-reads it too.
    await saveTheme('system');
    await page.evaluate(() => dispatchEvent(new Event('pageshow')));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
    await expect(group.getByRole('radio', { name: 'System' })).toBeChecked();
    await verifyClean();
  });

  test('a switch in one tab reaches the viewer’s other tabs', async ({
    context,
  }) => {
    const first = await openPage(context, 'the first tab');
    const second = await openPage(context, 'the second tab');
    const verifyFirst = await watchForProblems(first);
    const verifySecond = await watchForProblems(second);
    const { group } = await openSettings(first);
    await openSettings(second);

    await group.getByRole('radio', { name: 'Light' }).click();
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(
      second
        .getByRole('radiogroup', { name: 'Theme' })
        .getByRole('radio', { name: 'Light' }),
    ).toBeChecked();
    await expect.poll(() => themeColors(second)).toEqual(LIGHT_CHROME);
    await verifyFirst();
    await verifySecond();
  });
});
