import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const MODULE_PATH = JSON.stringify(
  new URL('../packages/observability/src/index.ts', import.meta.url).pathname,
);
const READY_MARKER = 'process-lifecycle-fixture-ready';

/**
 * A real child process wiring both ISSUE-150 seams
 * (`installForcedShutdown`, `watchParentLiveness`) exactly as
 * `apps/web/scripts/auth-load/instance-process.ts` does, then hanging
 * forever in place of its potentially slow `import('../../src/server/
 * start')` — proving the seams work against a real signal and a real
 * stdin pipe, independent of whichever import actually stalls in
 * production.
 */
const spawnHangingInstance = () =>
  Bun.spawn(
    [
      'bun',
      '-e',
      `const { installForcedShutdown, watchParentLiveness } = await import(${MODULE_PATH});
       installForcedShutdown({ drainBudgetMs: 500, exit: (code) => process.exit(code) });
       watchParentLiveness({ stdin: process.stdin, onParentGone: () => process.exit(0) });
       console.log(${JSON.stringify(READY_MARKER)});
       await new Promise(() => {});`,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );

/** Waits for the fixture's readiness marker, so a signal is never raced against handler installation. */
async function waitUntilReady(
  stdout: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes(READY_MARKER)) {
    const { value, done } = await reader.read();
    if (done) throw new Error('Fixture exited before signaling ready');
    buffer += decoder.decode(value);
  }
  reader.releaseLock();
}

describe('the ISSUE-150 process-lifecycle seams against a real process', () => {
  test('a real SIGTERM forces exit within the drain budget, even mid-hang', async () => {
    const child = spawnHangingInstance();
    await waitUntilReady(child.stdout as ReadableStream<Uint8Array>);
    const started = performance.now();
    child.kill('SIGTERM');
    const exitCode = await child.exited;
    const elapsedMs = performance.now() - started;
    assert({
      given: 'SIGTERM sent to a process hung on start-up',
      should: 'exit 0 within the configured drain budget, not hang',
      actual: { exitCode, withinBudget: elapsedMs < 4000 },
      expected: { exitCode: 0, withinBudget: true },
    });
  });

  test('closing the parent stdin pipe (parent died) forces exit without any signal', async () => {
    const child = spawnHangingInstance();
    await waitUntilReady(child.stdout as ReadableStream<Uint8Array>);
    const started = performance.now();
    // The parent process dying closes its end of the pipe; ending the
    // writable stream from this side reproduces exactly that EOF.
    await child.stdin.end();
    const exitCode = await child.exited;
    const elapsedMs = performance.now() - started;
    assert({
      given: "the parent's stdin pipe closing, with no signal ever sent",
      should: 'exit 0 promptly, never surviving as an orphan',
      actual: { exitCode, elapsedMsUnderFiveSeconds: elapsedMs < 5000 },
      expected: { exitCode: 0, elapsedMsUnderFiveSeconds: true },
    });
  });

  test('negative control: without either seam wired, the hang never exits on stdin close', async () => {
    const child = Bun.spawn(['bun', '-e', 'await new Promise(() => {});'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      await child.stdin.end();
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(1000).then(() => false),
      ]);
      assert({
        given: 'a hanging process with neither ISSUE-150 seam installed',
        should:
          'still be running after the same wait, proving the seams above do the work',
        actual: exited,
        expected: false,
      });
    } finally {
      child.kill('SIGKILL');
    }
  });
});
