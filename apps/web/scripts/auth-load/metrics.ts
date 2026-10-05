import type { WorkloadOutcome } from './workload';

export type OutcomeTally = {
  offered: number;
  successful: number;
  /** Non-2xx/3xx statuses the server itself returned, keyed by status. */
  rejectedByStatus: Record<number, number>;
  timedOut: number;
  unexpectedFailure: number;
};

const emptyTally = (): OutcomeTally => ({
  offered: 0,
  successful: 0,
  rejectedByStatus: {},
  timedOut: 0,
  unexpectedFailure: 0,
});

const SUCCESS_STATUSES = new Set([200, 201, 303]);
// The one status the shipped rate limiter deliberately returns under load
// (AUTH-6.7 AC4: "report deliberate 429s ... separately"); every other
// non-2xx/3xx status, 503 included, counts toward the unexpected-failure
// rate the criterion caps at 1% — a 503 in a run with the real database and
// Redis reachable throughout is a real capacity signal, not a fixture.
const DELIBERATE_REJECTION_STATUSES = new Set([429]);

export function tally(
  outcomes: Iterable<WorkloadOutcome>,
): Record<'overall' | WorkloadOutcome['kind'], OutcomeTally> {
  const result: Record<string, OutcomeTally> = {
    overall: emptyTally(),
    'session-read': emptyTally(),
    'magic-link': emptyTally(),
    'passkey-assertion': emptyTally(),
  };
  for (const outcome of outcomes) {
    for (const bucket of [result.overall!, result[outcome.kind]!]) {
      bucket.offered += 1;
      if (outcome.status === 'timeout') {
        bucket.timedOut += 1;
      } else if (
        outcome.status === 'error' ||
        outcome.status === 'empty-session'
      ) {
        // 'empty-session': a 200 whose body carries no session (a stale or
        // invalid cookie) is not the success it looks like at the status
        // line alone.
        bucket.unexpectedFailure += 1;
      } else if (SUCCESS_STATUSES.has(outcome.status)) {
        bucket.successful += 1;
      } else {
        bucket.rejectedByStatus[outcome.status] =
          (bucket.rejectedByStatus[outcome.status] ?? 0) + 1;
        if (!DELIBERATE_REJECTION_STATUSES.has(outcome.status))
          bucket.unexpectedFailure += 1;
      }
    }
  }
  return result as Record<'overall' | WorkloadOutcome['kind'], OutcomeTally>;
}

/** Server-observed latency percentile, `p` in (0, 100], nearest-rank. */
export function percentile(latenciesMs: readonly number[], p: number): number {
  if (latenciesMs.length === 0) return 0;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
}

/**
 * The 99% success bar's admitted count and rate. AUTH-6.7 AC4 excludes only
 * the magic-link segment's documented, deliberate 429 ceiling (it sits at
 * the shipped global rate limit by construction — see the harness README) —
 * a 429 storm on session-read or passkey-assertion is a real capacity
 * failure and must count against the bar, not be excluded from it
 * (ISSUE-165).
 */
export function successRate(
  tallies: Record<'overall' | WorkloadOutcome['kind'], OutcomeTally>,
): { readonly admitted: number; readonly rate: number } {
  const magicLink429 = tallies['magic-link'].rejectedByStatus[429] ?? 0;
  const admitted = tallies.overall.offered - magicLink429;
  return {
    admitted,
    rate: admitted === 0 ? 0 : tallies.overall.successful / admitted,
  };
}

/** Unexpected 5xx as a share of offered traffic (AUTH-6.7 AC2: below 1%). */
export const unexpected5xxRate = (t: OutcomeTally): number => {
  const unexpected5xx = Object.entries(t.rejectedByStatus)
    .filter(([status]) => Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);
  return t.offered === 0 ? 0 : unexpected5xx / t.offered;
};
