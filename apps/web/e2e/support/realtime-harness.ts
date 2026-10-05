import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the real `createBrowserConnectionStore` into a browser-runnable
 * script that assigns it to `window.__offenseDemoRealtimeHarness`, for injection
 * into a live page via `page.addScriptTag`. RT-2.6a has no UI route of its
 * own (out of scope: "no UI wiring"), so the browser proof runs the store
 * against a real page instead of a feature route.
 *
 * Playwright's own test runner is `node .../cli.js test` (this repo's
 * `test:e2e` script), so the global `Bun` build API is unavailable here;
 * this shells out to the `bun build` CLI instead (Bun is this repo's only
 * package manager and runtime, always on PATH).
 */
export function buildRealtimeHarnessScript(): string {
  const entry = fileURLToPath(
    new URL('./realtime-harness-entry.ts', import.meta.url),
  );
  return execFileSync(
    'bun',
    ['build', entry, '--target=browser', '--format=iife'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}
