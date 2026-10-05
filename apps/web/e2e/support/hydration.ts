import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Resolves once the page has hydrated and run its mount effects, with no
 * timer and no network-idle wait. The root layout's ThemeProvider starts
 * following the theme cookie in an effect, and React runs a parent's effects
 * after its children's, so once the page applies a cookie change every
 * effect of that render has run, SessionRefresh's included. The probe is a
 * `visibilitychange`, which the provider answers by re-reading the cookie;
 * it is repeated because a probe sent before the effect is not heard.
 */
export async function effectsRan(page: Page) {
  const html = page.locator('html');
  const theme = await html.getAttribute('data-theme');
  const flipped = theme === 'dark' ? 'light' : 'dark';
  await page.context().addCookies([
    {
      name: 'offense-demo-theme',
      value: flipped,
      url: new URL(page.url()).origin,
    },
  ]);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        return document.documentElement.dataset['theme'];
      }),
    )
    .toBe(flipped);
}

/**
 * Resolves once React has hydrated the element `locator` finds, so a click
 * reaches its handler instead of an inert server-rendered node. React tags
 * hydrated DOM nodes with a `__reactProps$…` key. It waits as long as the
 * test allows, with no timer of its own: under load, hydration can lag the
 * first paint by seconds (ISSUE-84).
 */
export async function hydrated(locator: Locator) {
  await locator
    .page()
    .waitForFunction(
      (element) =>
        element !== null &&
        Object.keys(element).some((key) => key.startsWith('__reactProps$')),
      await locator.elementHandle(),
    );
}
