import type { Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { openPage } from './fixtures';

/**
 * The stall evidence's live controls (ISSUE-279, ISSUE-282): freezing this
 * worker's browser with SIGSTOP so a page creation really stalls in the
 * browser, and thawing it however the attempt ends.
 */
/** The pids of this worker's descendants: its browser and their helpers. */
const descendants = () => {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/, 3));
  const found = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid, comm] of rows)
      if (found.has(Number(ppid)) && !found.has(Number(pid)) && comm !== 'ps') {
        found.add(Number(pid));
        grew = true;
      }
  }
  found.delete(process.pid);
  return [...found];
};
const signal = (pids: number[], name: NodeJS.Signals) => {
  for (const pid of pids)
    try {
      process.kill(pid, name);
    } catch {
      // A helper that exited meanwhile needs no signal.
    }
};

/**
 * Freezes this worker's browser (SIGSTOP), opens a page in it through
 * openPage, and thaws it: the failure, how long the whole attempt took,
 * evidence capture included, and the evidence written.
 */
export const openInFrozenBrowser = async (
  browser: Browser,
  outputPath: string,
  purpose: string,
  options: Parameters<typeof openPage>[2],
) => {
  const context = await browser.newContext();
  const frozen = descendants();
  signal(frozen, 'SIGSTOP');
  // Thaws the browser even if openPage never returns and the test times out
  // before its finally runs: a stopped browser must not outlive the control.
  const thaw = setTimeout(() => signal(frozen, 'SIGCONT'), 10_000);
  const started = performance.now();
  let failure: Error | undefined;
  try {
    await openPage(context, purpose, options);
  } catch (error) {
    failure = error as Error;
  } finally {
    clearTimeout(thaw);
    signal(frozen, 'SIGCONT');
  }
  const elapsedMs = performance.now() - started;
  const evidence = await readFile(outputPath, 'utf8');
  await context.close();
  return { frozen: frozen.length > 0, failure, elapsedMs, evidence };
};
