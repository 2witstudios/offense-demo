import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Fails on any serious/critical finding; moderate/minor are not gating. */
export async function assertNoSeriousFindings(page: Page) {
  // Contrast checks read real computed/rendered colors; scanning before the
  // brand webfont finishes swapping in can catch a mid-swap paint and
  // misreport a transient color, so wait for fonts to settle first.
  await page.evaluate(() => document.fonts.ready);
  // Legacy mode is a cost cut, not a coverage choice. The default mode
  // gathers each frame's results in a second, blank page, which adds a page
  // and several round trips to every scan (2.5x the time under load,
  // ISSUE-198); the app renders no frames, so that orchestration covers
  // nothing here. Legacy mode skips cross-origin frames, so a page that
  // gains one must fail here rather than be scanned with less coverage.
  expect(
    page.frames(),
    'axe runs in legacy mode, which skips cross-origin frames: drop setLegacyMode in e2e/support/axe.ts now that this page embeds a frame',
  ).toHaveLength(1);
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}
