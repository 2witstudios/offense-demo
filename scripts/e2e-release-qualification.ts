import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  countsByProject,
  countsProblems,
  formatCounts,
} from './e2e-report-counts';

/**
 * AUTH-6.2 release qualification: the complete auth browser suite, retries
 * disabled (already the standing config — see playwright.config.ts), run
 * three consecutive times against a fresh server per run (Playwright's
 * webServer is spawned and torn down by each invocation). Every one of the
 * three outcomes is retained; any failure in any run fails the gate. This is
 * a release-time check, not a per-PR CI gate — the fast single-run e2e
 * workflow stays the required PR check (docs/development/testing.md).
 */
// Deliberately NOT under apps/web/test-results: Playwright clears that
// whole directory at the start of every invocation, so a subdirectory of
// it would have run N's report deleted the moment run N+1 starts, leaving
// only the final run's outcome instead of all three.
const runsDirectory = 'apps/web/qualification-results';

type RunOutcome = {
  readonly run: number;
  readonly ok: boolean;
  readonly summary: string;
};

async function runOnce(run: number): Promise<RunOutcome> {
  const proc = Bun.spawnSync(['bun', 'run', '--cwd', 'apps/web', 'test:e2e'], {
    env: { ...process.env, CI: 'true' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  // Playwright clears its own output directory (test-results) at the start
  // of every invocation, so this is recreated after each run, not once up
  // front, or it would not exist by the time this run writes into it.
  mkdirSync(runsDirectory, { recursive: true });
  const reportPath = 'apps/web/test-results/results.json';
  const savedPath = `${runsDirectory}/run-${run}.json`;
  let ok = proc.exitCode === 0;
  let summary = `exit code ${proc.exitCode}`;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    writeFileSync(savedPath, JSON.stringify(report, null, 2));
    const byProject = countsByProject(report);
    const problems = countsProblems(byProject);
    ok = ok && problems.length === 0;
    summary = formatCounts(byProject);
  } catch (error) {
    ok = false;
    summary = `could not read ${reportPath}: ${String(error)}`;
  }
  return { run, ok, summary };
}

/** True once nothing accepts a connection on `port` (the OS has released it). */
async function isPortFree(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data() {},
        open(s) {
          s.end();
        },
        error() {},
      },
    });
    socket.end();
    return false;
  } catch {
    return true;
  }
}

/**
 * Each run's webServer is spawned fresh (not reused): its own graceful
 * shutdown (up to playwright.config.ts's 30s `gracefulShutdown.timeout`) can
 * outlast the wrapping CLI process on this platform, and a closed listener's
 * port can also sit in TIME_WAIT briefly, so a lingering bind from run N
 * would otherwise fail run N+1's bind with EADDRINUSE. Kill anything still
 * bound under this worktree's e2e wrapper, then poll (never a flat sleep)
 * until every one of its three ports is actually free.
 */
async function settleBetweenRuns(): Promise<void> {
  Bun.spawnSync(['pkill', '-f', `${process.cwd()}.*e2e/support/server.ts`]);
  const { resolveE2EPorts } = await import('../apps/web/playwright.config');
  const ports = Object.values(resolveE2EPorts(process.env));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const free = await Promise.all(ports.map(isPortFree));
    if (free.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `ports ${ports.join(', ')} were still bound 30s after the previous run`,
  );
}

if (import.meta.main) {
  const outcomes: RunOutcome[] = [];
  await settleBetweenRuns();
  for (let run = 1; run <= 3; run += 1) {
    console.log(`\n=== Release qualification run ${run}/3 ===`);
    outcomes.push(await runOnce(run));
    await settleBetweenRuns();
  }
  for (const outcome of outcomes)
    console.log(
      `\nRun ${outcome.run}: ${outcome.ok ? 'PASS' : 'FAIL'}\n${outcome.summary}`,
    );
  writeFileSync(
    `${runsDirectory}/summary.json`,
    JSON.stringify(outcomes, null, 2),
  );
  process.exitCode = outcomes.every((outcome) => outcome.ok) ? 0 : 1;
}
