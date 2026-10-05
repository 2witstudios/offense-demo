import { expect, type Locator, type Page } from '@playwright/test';

/** Where focus is, read from the document itself. */
const activeElement = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName.toLowerCase(), id: active?.id };
  });

/** `document.activeElement` settles on the element `tag#id`, never `<body>`. */
export const expectFocusOn = (page: Page, tag: 'input' | 'h1', id: string) =>
  expect.poll(() => activeElement(page)).toEqual({ tag, id });

/**
 * Focuses `control` and presses Enter on it, touching nothing else. The
 * page streams in behind the root loading boundary; a focus sent before the
 * reveal lands on the hidden copy (ISSUE-45).
 */
export const pressByKeyboard = async (control: Locator) => {
  await expect(control).toBeVisible();
  await control.focus();
  await expect(control).toBeFocused();
  await control.page().keyboard.press('Enter');
};
