import { expect, type Locator, type Page } from '@playwright/test';
import { hydrated } from './hydration';

/** The rows of one account-security list, found by its section heading. */
export const securityRows = (page: Page, list: 'Passkeys' | 'Sessions') =>
  page.getByRole('region', { name: list }).getByRole('listitem');

/**
 * Clicks one row's own control and waits for that row to leave its list,
 * which happens only once the request has answered ok. The control is no
 * signal: it relabels ("Removing…", "Signing out…") while the request is
 * still in flight, so a wait for its label to vanish passes early and
 * whatever the test checks next races the request (ISSUE-174, ISSUE-183).
 */
export async function removeRowByClick(
  rows: Locator,
  control: Locator,
  before: number,
) {
  await expect(rows).toHaveCount(before);
  // Under load, hydration can lag first paint by seconds (ISSUE-84): a
  // click before React wires the handler is a silent no-op.
  await hydrated(control);
  await control.click();
  await expect(rows).toHaveCount(before - 1);
}
