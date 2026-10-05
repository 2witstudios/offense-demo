import type { PasskeyAutofillOutcome } from '../sign-in-port';

/**
 * How long one autofill request stays pending before it is replaced. It must
 * stay under `@better-auth/passkey`'s 300 s challenge lifetime, or a person
 * who picks a passkey later is refused for a challenge the server dropped.
 */
export const AUTOFILL_REFRESH_MS = 240_000;
const FIRST_RETRY_MS = 1_000;
/**
 * A request that sat pending this long was ended by a person (a dismissed
 * prompt, a pick), not by a fault that answers at once, so the backoff
 * restarts instead of growing.
 */
const PERSON_ENDED_MS = 5_000;

/**
 * Delay before re-offering after the `streak`-th consecutive quick ending:
 * 1 s, 2 s, 4 s … capped at the refresh interval, so a failing service
 * (every request costs a challenge and a rate-limit slot) is never hammered.
 */
export const autofillRetryDelayMs = (streak: number): number =>
  Math.min(FIRST_RETRY_MS * 2 ** streak, AUTOFILL_REFRESH_MS);

/** Injected so the loop is testable and never schedules on ambient time. */
export type AutofillTimers = {
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
};

/**
 * A replaced request can still be the one the browser shows until the newer
 * offer's options arrive, so what a pick produced is reported even then.
 */
const fromPick = (outcome: PasskeyAutofillOutcome): boolean =>
  outcome.kind === 'signed-in' || outcome.kind === 'refused';

/**
 * Keeps one autofill request pending while the email step is idle: refreshed
 * before its challenge expires, and re-offered with backoff after any other
 * ending until the browser proves it cannot autofill. A newer request aborts
 * the pending one, so a replaced request's ending is stale and dropped
 * unless a pick produced it; a live request superseded by a stale one is
 * offered again after the backoff step, which aborts that one in turn.
 * Returns the function that stops the loop.
 */
export function startPasskeyAutofill({
  offer,
  onSettled,
  timers,
  now,
}: {
  readonly offer: () => Promise<PasskeyAutofillOutcome>;
  readonly onSettled: (outcome: PasskeyAutofillOutcome) => void;
  readonly timers: AutofillTimers;
  /** Epoch milliseconds from the injected clock. */
  readonly now: () => number;
}): () => void {
  let generation = 0;
  let timer: unknown;
  const arm = (streak: number): void => {
    generation += 1;
    const current = generation;
    const startedAt = now();
    timers.clear(timer);
    timer = timers.set(() => arm(0), AUTOFILL_REFRESH_MS);
    void offer().then((outcome) => {
      if (!fromPick(outcome) && current !== generation) return;
      onSettled(outcome);
      if (current !== generation) return;
      timers.clear(timer);
      if (outcome.kind === 'signed-in' || outcome.kind === 'unavailable') {
        timer = undefined;
        return;
      }
      const quick = now() - startedAt < PERSON_ENDED_MS;
      timer = timers.set(
        () => arm(quick ? streak + 1 : 0),
        autofillRetryDelayMs(quick ? streak : 0),
      );
    });
  };
  arm(0);
  return () => {
    generation += 1;
    timers.clear(timer);
  };
}
