import type { Page } from '@playwright/test';

export type CspViolation = {
  readonly directive: string;
  readonly blocked: string;
};

/**
 * Registers the console and `securitypolicyviolation` listeners before any
 * document script runs, so no early violation is missed. Call `read()` after
 * the page under test has settled.
 */
export async function watchCspViolations(page: Page) {
  const consoleViolations: string[] = [];
  page.on('console', (message) => {
    if (/content security policy|refused to/i.test(message.text()))
      consoleViolations.push(message.text());
  });
  await page.addInitScript(() => {
    const seen: { directive: string; blocked: string }[] = [];
    Reflect.set(window, '__cspViolations', seen);
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      });
    });
  });
  return {
    async read(): Promise<{
      readonly consoleViolations: readonly string[];
      readonly eventViolations: readonly CspViolation[];
    }> {
      const eventViolations = await page.evaluate(
        () => Reflect.get(window, '__cspViolations') as CspViolation[],
      );
      return { consoleViolations, eventViolations };
    },
  };
}
