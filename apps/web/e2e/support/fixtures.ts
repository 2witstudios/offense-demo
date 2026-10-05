import * as playwright from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { boundedStep, STEP_LIMIT_MS, StepTimeoutError } from './bounded-step';
import {
  protocolLog,
  recordProtocol,
  recordStall,
  startWindow,
} from './stall-capture';

/**
 * Per-test browser diagnostics for every spec (ISSUE-234, ISSUE-253): each
 * watched page's console messages and uncaught errors, and every CDP
 * WebAuthn event and ceremony marker recorded through `recordDiagnostic`.
 * A failed test writes them to `browser-diagnostics.log` in its output
 * folder, beside the trace, so a stalled create() or get() shows whether
 * the page never called it, called it and heard nothing back, or the
 * authenticator answered and the page stopped. `bun verify` archives that
 * folder with the rest of test-results.
 */
const lines: string[] = [];
let started = 0;
const labels = new WeakMap<Page, string>();
let pages = 0;
const watched = new WeakSet<Page>();

/** Names each page in the log by the order it was first seen in the test. */
const labelOf = (page: Page) => {
  const known = labels.get(page);
  if (known) return known;
  const label = `page${(pages += 1)}`;
  labels.set(page, label);
  return label;
};

export function recordDiagnostic(page: Page, line: string) {
  lines.push(
    `+${Math.round(performance.now() - started)}ms ${labelOf(page)} ${line}`,
  );
}

/** Starts recording a page's console messages and uncaught errors. */
export function watchPage(page: Page) {
  if (watched.has(page)) return;
  watched.add(page);
  labelOf(page);
  page.on('console', (message) =>
    recordDiagnostic(page, `console.${message.type()} ${message.text()}`),
  );
  page.on('pageerror', (error) =>
    recordDiagnostic(page, `pageerror ${error.name}: ${error.message}`),
  );
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      recordDiagnostic(page, `navigated ${new URL(frame.url()).pathname}`);
  });
}

/**
 * Opens a page in `context`, bounded (ISSUE-253, ISSUE-277): a newPage that
 * never answers fails by name within `limitMs` instead of as a bare 30 s
 * timeout, and leaves stall-evidence.log naming the layer that stopped, the
 * browser, the driver or our server (ISSUE-279). The page is watched, so a
 * failed test keeps its console and errors. The one route to a page: the
 * lint gate rejects a direct newPage anywhere else.
 */
export async function openPage(
  context: BrowserContext,
  purpose: string,
  {
    limitMs = STEP_LIMIT_MS,
    processSnapshot,
  }: {
    readonly limitMs?: number;
    readonly processSnapshot?: () => Promise<string>;
  } = {},
): Promise<Page> {
  const step = `opening ${purpose}`;
  const from = startWindow();
  try {
    const page = await boundedStep(step, () => context.newPage(), limitMs);
    watchPage(page);
    return page;
  } catch (error) {
    if (!(error instanceof StepTimeoutError)) throw error;
    const cause = await recordStall(
      playwright.test.info(),
      { step, from, limitMs },
      processSnapshot,
    );
    throw new Error(
      `${error.message}; cause: ${cause} (see stall-evidence.log)`,
      { cause: error },
    );
  }
}

/**
 * Every spec's test (ISSUE-253; a lint rule rejects importing Playwright's
 * own). Every test records Playwright's protocol traffic, so a failed test
 * keeps protocol.log and a stalled page creation can be judged (ISSUE-279).
 * Its page opens through openPage, and a failed test keeps its
 * browser-diagnostics.log beside its trace.
 */
export const test = playwright.test.extend<{ protocolLog: void }>({
  protocolLog: [
    // Playwright reads fixture dependencies from this pattern: none here.
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide, testInfo) => {
      lines.length = 0;
      pages = 0;
      started = performance.now();
      const stop = recordProtocol();
      try {
        await provide();
      } finally {
        stop();
      }
      if (testInfo.status !== testInfo.expectedStatus)
        await writeFile(
          testInfo.outputPath('protocol.log'),
          `${protocolLog()}\n`,
        );
    },
    { auto: true },
  ],
  page: async ({ context, protocolLog: _recording }, provide, testInfo) => {
    const page = await openPage(context, 'the test page (fixture setup)');
    await provide(page);
    if (testInfo.status !== testInfo.expectedStatus)
      await writeFile(
        testInfo.outputPath('browser-diagnostics.log'),
        `${lines.join('\n')}\n`,
      );
  },
});

export { expect } from '@playwright/test';
