/**
 * Polls `health` until it answers true or `maxAttempts` is spent, sleeping
 * `intervalMs` between attempts. Used by the retention sweep's start-up run
 * (ISSUE-146): a freshly started Fly machine's Redis connection is not
 * necessarily ready the instant the process starts listening, so the first
 * sweep waits for it instead of logging a spurious `retention.sweep.failed`.
 * A `health` rejection counts as not-yet-ready, never a thrown failure, and
 * so does an attempt still pending after `attemptTimeoutMs`: Bun bounds only
 * connection establishment, not a PING, so a stalled command must not hold
 * the loop forever.
 */
export async function waitForHealthy({
  health,
  sleep,
  timeout,
  maxAttempts = 40,
  intervalMs = 250,
  attemptTimeoutMs = 1_000,
}: {
  readonly health: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Resolves after `ms`; bounds each attempt. */
  readonly timeout: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
  readonly attemptTimeoutMs?: number;
}): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const healthy = await Promise.race([
      health().catch(() => false),
      timeout(attemptTimeoutMs).then(() => false),
    ]);
    if (healthy) return true;
    if (attempt < maxAttempts - 1) await sleep(intervalMs);
  }
  return false;
}
