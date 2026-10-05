/**
 * ISSUE-150: shutdown seams for ephemeral, non-serving processes (a
 * load-test harness instance, a one-shot job) that need a bounded exit on
 * a signal or on their parent dying, not `index.ts`'s graceful HTTP drain
 * (`installShutdownSignals`).
 */

/** The subset of `process` a signal handler needs; a test injects a fake. */
export type SignalTarget = { readonly once: typeof process.once };

/**
 * Forces a process to exit within `drainBudgetMs` of SIGTERM or SIGINT.
 * Install this before any slow start-up work runs: a hang later can then
 * never leave the process ignoring the signal, since the handler is
 * already registered.
 */
export function installForcedShutdown({
  drainBudgetMs,
  exit,
  target = process,
  signals = ['SIGTERM', 'SIGINT'],
  schedule = setTimeout,
}: {
  readonly drainBudgetMs: number;
  readonly exit: (code: number) => void;
  readonly target?: SignalTarget;
  readonly signals?: readonly NodeJS.Signals[];
  readonly schedule?: (callback: () => void, ms: number) => unknown;
}): void {
  for (const signal of signals)
    target.once(signal, () => {
      schedule(() => exit(0), drainBudgetMs);
    });
}

/** The subset of a readable stream a parent-liveness watch needs. */
export type LivenessStdin = {
  readonly on: (event: 'end' | 'close', listener: () => void) => unknown;
  readonly resume?: () => unknown;
};

/**
 * Exits the moment a piped parent's stdin closes — the EOF a piped child
 * always receives when its parent dies for any reason, including a
 * SIGKILL or a crash that never delivers SIGTERM. A caller spawns the
 * child with `stdin: 'pipe'` and never writes to or closes it, so the
 * pipe stays open for exactly as long as the parent process does.
 * `resume()` puts the stream in flowing mode: an unread stdin never emits
 * `end` at all.
 */
export function watchParentLiveness({
  stdin,
  onParentGone,
}: {
  readonly stdin: LivenessStdin;
  readonly onParentGone: () => void;
}): void {
  let fired = false;
  const fireOnce = () => {
    if (fired) return;
    fired = true;
    onParentGone();
  };
  stdin.on('end', fireOnce);
  stdin.on('close', fireOnce);
  stdin.resume?.();
}
