/**
 * What the hand-run proof scripts (`bun proof:test-redis`,
 * `bun proof:test-postgres`) share: numbered PASS/FAIL steps and an exit code
 * that fails when any step did.
 */
export function proofSteps() {
  const failures: string[] = [];
  return {
    /** A step: on failure it also prints `observed`, what the proof actually saw, so a failed control names its cause. */
    check: (ok: boolean, what: string, observed?: unknown) => {
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${what}\n`);
      if (!ok) {
        failures.push(what);
        if (observed !== undefined)
          process.stdout.write(`      observed: ${JSON.stringify(observed)}\n`);
      }
    },
    /** Prints the verdict and exits non-zero when any step failed. */
    finish: () => {
      if (failures.length > 0) {
        process.stderr.write(`\n${failures.length} proof step(s) failed\n`);
        process.exit(1);
      }
      process.stdout.write('\nall proof steps passed\n');
    },
  };
}
