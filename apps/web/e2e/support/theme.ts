import type { Page } from '@playwright/test';

export type Theme = 'light' | 'dark';

/**
 * Navigates with the theme cookie already set, so the server renders the
 * requested `data-theme` from the first response (no flash, no client
 * switch to wait on).
 */
export async function gotoWithTheme(
  page: Page,
  path: string,
  theme: Theme,
): Promise<void> {
  await page.goto(path);
  await page.context().addCookies([
    {
      name: 'offense-demo-theme',
      value: theme,
      url: new URL(page.url()).origin,
    },
  ]);
  await page.goto(path);
}
