import { randomBytes } from 'node:crypto';
import type { DocumentPipeline } from './docs-pipeline';
import type { DocumentationDrive } from './pagespace-docs';

// How a documentation dispatch is bounded and which replay it addresses,
// resolved from explicit options first and the CI environment second.

// The consult route answers only when the run finishes, and a run takes
// minutes. The answer can still be lost on its way back (a dropped connection,
// a gateway 5xx), so the socket is not the receipt, the conversation is: the
// route persists the question before the run and the answer after it. Under
// load, two consults in flight at once were both cut off and a run took 16
// minutes, so pipelines are consulted one at a time: each waits up to
// DEFAULT_WAIT_MS, all share DEFAULT_BUDGET_MS, and the budget ends inside the
// 45-minute CI job so an expired budget fails the step, and posts the
// incident, before the job is cancelled. No answer by then means unknown, not
// dead: a late run still rewrites its reserved row. Only the consult route's
// own failure proves a run dead, since the route answers once its run ends.
const DEFAULT_WAIT_MS = 20 * 60_000;
const DEFAULT_BUDGET_MS = 42 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
// Lookups and reservations answer in milliseconds; only the consult runs for
// minutes. Capping each one keeps a hung call from spending the whole budget.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type ConsultOptions = {
  /** The drive layout (`documentationDrive(loadProjectConfig())` in the CLI). */
  readonly drive?: DocumentationDrive;
  readonly token?: string;
  readonly apiUrl?: string;
  readonly agentId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly nonce?: () => string;
  readonly timeoutMs?: number;
  readonly budgetMs?: number;
  readonly budgetEndsAt?: number;
  readonly requestTimeoutMs?: number;
  readonly pipelines?: readonly string[];
  readonly attempt?: number;
  readonly pollIntervalMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  /** The clock deadlines are measured on; tests inject one with `delay`. */
  readonly now?: () => number;
};

// A replay targets only the pipelines that need it, so recovering one dead run
// never re-runs a healthy one under a fresh id. A name the event does not
// route to is a mistake, not an empty replay.
export function replayPipelines(
  value: readonly string[] | undefined,
  routed: readonly DocumentPipeline[],
): readonly DocumentPipeline[] {
  const named =
    value ??
    (process.env.DOC_PIPELINES ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
  if (named.length === 0) return routed;
  for (const name of named)
    if (!routed.includes(name as DocumentPipeline))
      throw new Error(
        `DOC_PIPELINES names ${name}, which this event does not route to (${routed.join(', ')})`,
      );
  return routed.filter((pipeline) => named.includes(pipeline));
}

// CI records when the job's share of time runs out (DOC_BUDGET_ENDS_AT, epoch
// seconds) in the job's first step, because the job timeout starts before
// checkout and setup do. Anchoring to it keeps the incidents step reachable
// however long preparation took.
function jobBudgetEnd(): number {
  const raw = process.env.DOC_BUDGET_ENDS_AT;
  if (raw === undefined || raw === '') return Number.POSITIVE_INFINITY;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0)
    throw new Error(
      'DOC_BUDGET_ENDS_AT must be a positive integer (epoch seconds)',
    );
  return seconds * 1000;
}

export function replayAttempt(value: number | undefined): number {
  const attempt = value ?? Number(process.env.DOC_REPLAY_ATTEMPT ?? 0);
  if (!Number.isInteger(attempt) || attempt < 0)
    throw new Error('DOC_REPLAY_ATTEMPT must be a non-negative integer');
  return attempt;
}

export function resolveOptions(options: ConsultOptions) {
  const now = options.now ?? Date.now;
  const { drive } = options;
  if (drive === undefined)
    throw new Error('A documentation dispatch needs its drive layout');
  return {
    now,
    drive,
    agentId: options.agentId ?? drive.agentPageId,
    fetchImpl: options.fetchImpl ?? fetch,
    nonce: options.nonce ?? (() => randomBytes(16).toString('hex')),
    timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
    budgetEnd: Math.min(
      now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
      options.budgetEndsAt ?? jobBudgetEnd(),
    ),
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    delay:
      options.delay ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
}
