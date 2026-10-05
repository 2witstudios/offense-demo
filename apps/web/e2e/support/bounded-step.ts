/**
 * The limit for one step that has no timeout of its own: well under the
 * 30 s test budget, so a stuck step fails by name instead of as a bare
 * "Test timeout of 30000ms exceeded" (ISSUE-212). It changes diagnosis, not
 * the pass budget: a step this slow would have used the whole test anyway.
 */
export const STEP_LIMIT_MS = 15_000;

/**
 * A bounded step that outlived its limit, typed so a caller recognises its
 * own timeout without matching message text (ISSUE-284's nit).
 */
export class StepTimeoutError extends Error {
  constructor(
    readonly step: string,
    readonly ms: number,
  ) {
    super(`${step} did not finish within ${ms} ms`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Runs `run` and fails with a StepTimeoutError naming `step` if it has not
 * settled within `ms`. For calls Playwright gives no timeout of their own:
 * CDP commands and closing a browser context.
 */
export async function boundedStep<T>(
  step: string,
  run: () => Promise<T>,
  ms: number = STEP_LIMIT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(step, ms)), ms);
  });
  try {
    return await Promise.race([run(), limit]);
  } finally {
    clearTimeout(timer);
  }
}
