/**
 * Jittered exponential backoff for the socket's reconnect schedule (ADR 0031
 * §8): no lifetime ceiling on clean reconnects, so this only ever bounds the
 * delay of a single attempt, never the number of attempts. `random` is
 * injected (never `Math.random` read here) so tests are deterministic; the
 * jitter itself is not security-adjacent, so a CSPRNG is not required.
 */
export type ReconnectKind = 'standard' | 'rate-limited' | 'immediate';

export type ReconnectDelayInput = {
  readonly kind: ReconnectKind;
  readonly attempt: number;
  readonly random: () => number;
};

const BASE_MS = 1_000;
const STANDARD_MAX_MS = 30_000;
const RATE_LIMITED_FLOOR_MS = 30_000;
const RATE_LIMITED_MAX_MS = 60_000;
const IMMEDIATE_MAX_MS = 5_000;

/** Full jitter: a uniform draw between 0 and the exponential ceiling. */
function exponentialCeilingMs(attempt: number, maxMs: number): number {
  const clampedAttempt = Math.max(0, attempt);
  return Math.min(maxMs, BASE_MS * 2 ** clampedAttempt);
}

/**
 * The delay before the next reconnect attempt, keyed by the close-code
 * reaction that triggered it (`decideOnClose` in `close-code-policy.ts`):
 * - `standard`: full jitter over an exponential ceiling capped at 30 s
 *   (1006, unknown codes, 4005 slow_consumer, and 4001 auth_failed once a
 *   fresh ticket has been fetched).
 * - `rate-limited`: full jitter over the same exponential ceiling, but never
 *   below a 30 s floor (4004 rate_limited, ADR 0031 §8).
 * - `immediate`: 0-5 s jitter, independent of attempt (4006
 *   server_restarting: "another instance takes it").
 */
export function nextReconnectDelayMs({
  kind,
  attempt,
  random,
}: ReconnectDelayInput): number {
  if (kind === 'immediate') return random() * IMMEDIATE_MAX_MS;
  if (kind === 'rate-limited') {
    const ceiling = exponentialCeilingMs(attempt, RATE_LIMITED_MAX_MS);
    return RATE_LIMITED_FLOOR_MS + random() * ceiling;
  }
  return random() * exponentialCeilingMs(attempt, STANDARD_MAX_MS);
}
