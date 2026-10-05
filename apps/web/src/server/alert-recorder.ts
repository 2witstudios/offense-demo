import type { Clock } from '@offense-demo/clock';
import type { LogFields, Logger } from '@offense-demo/logger';

const MINUTE_MS = 60_000;
/** Bridges the 2-minute unavailability threshold across gaps between failures without pinning the incident's start to the most recent one. Re-armed on every occurrence (markOccurrenceSince), so a continuous outage never lets the since-time lapse. */
const UNAVAILABLE_MARK_TTL_SECONDS = 180;
/** A quiet hour resets the consecutive-failure count; no legitimate retry cadence needs longer. */
const DELIVERY_FAILURE_WINDOW_SECONDS = 60 * 60;
/** Long-lived on purpose: cleared only by an actual successful sweep, so a multi-hour outage stays visible (ADR: see docs/decisions). */
const RETENTION_SUCCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Outlives the 10-minute read windows `alert-snapshot.ts` sums over. */
const HTTP_BUCKET_TTL_SECONDS = 11 * 60;

/** The current one-minute bucket `alert-snapshot.ts` sums trailing windows of. */
const minuteBucket = (clock: Clock) =>
  Math.floor(Date.parse(clock.now()) / MINUTE_MS);

export type AlertRecorderRedis = {
  readonly markOccurrenceSince: (
    key: string,
    value: string,
    ttlSeconds: number,
  ) => Promise<string>;
  readonly incrementWithExpiry: (
    key: string,
    ttlSeconds: number,
  ) => Promise<number>;
  readonly delete: (key: string) => Promise<void>;
  readonly setEphemeral: (
    key: string,
    value: string,
    ttlSeconds: number,
  ) => Promise<void>;
};

/** Never lets alert bookkeeping surface an error to the event it observed. */
const swallow = (promise: Promise<unknown>): void => {
  void promise.catch(() => {});
};

/**
 * The two HTTP lifecycle events, scoped to `auth.*` operations with a
 * numeric `status` (bounded cardinality: a small, known operation-name
 * set, never a raw path or identifier).
 */
const recordHttpOutcome = (
  redis: AlertRecorderRedis,
  clock: Clock,
  fields: Readonly<Record<string, unknown>>,
): void => {
  const { operation, status } = fields;
  if (typeof operation !== 'string' || !operation.startsWith('auth.')) return;
  if (typeof status !== 'number') return;
  const bucket = minuteBucket(clock);
  swallow(
    redis.incrementWithExpiry(
      `alert-http-total-${bucket}`,
      HTTP_BUCKET_TTL_SECONDS,
    ),
  );
  if (status >= 500)
    swallow(
      redis.incrementWithExpiry(
        `alert-http-5xx-${bucket}`,
        HTTP_BUCKET_TTL_SECONDS,
      ),
    );
};

/** An outage's first and latest occurrence, both UTC ISO timestamps. */
type OutageMark = { readonly sinceIso: string; readonly lastIso: string };

const withinBridge = (mark: OutageMark, nowIso: string): boolean =>
  Date.parse(nowIso) - Date.parse(mark.lastIso) <=
  UNAVAILABLE_MARK_TTL_SECONDS * 1000;

/**
 * The in-process twin of `markOccurrenceSince`: keeps the since-time while
 * occurrences arrive within the bridging TTL, and starts a new outage after
 * a longer quiet gap.
 */
const nextOutageMark = (mark: OutageMark | null, nowIso: string): OutageMark =>
  mark !== null && withinBridge(mark, nowIso)
    ? { sinceIso: mark.sinceIso, lastIso: nowIso }
    : { sinceIso: nowIso, lastIso: nowIso };

/**
 * Derives AUTH-7.7's durable, bounded-cardinality Redis alert state from the
 * structured event stream that already exists — no new call sites, no new
 * event names. `withAlertRecording` below feeds it every event the composed
 * `Logger` emits.
 */
export function createAlertRecorder({
  redis,
  clock,
}: {
  readonly redis: AlertRecorderRedis;
  readonly clock: Clock;
}) {
  // ISSUE-191: the limiter's Redis is the one the marker below is written
  // to, so its outage loses that marker; this process's own copy survives it.
  let limiterOutage: OutageMark | null = null;
  return {
    /**
     * When this process first saw the rate limiter unavailable in the current
     * outage, or null once none has occurred within the bridging TTL.
     */
    limiterUnavailableSince(): string | null {
      return limiterOutage !== null && withinBridge(limiterOutage, clock.now())
        ? limiterOutage.sinceIso
        : null;
    },
    observe(event: string, fields: Readonly<Record<string, unknown>>): void {
      switch (event) {
        case 'auth.session.unavailable':
          swallow(
            redis.markOccurrenceSince(
              'alert-unavailable-storage',
              clock.now(),
              UNAVAILABLE_MARK_TTL_SECONDS,
            ),
          );
          return;
        case 'auth.rate_limit.unavailable':
          limiterOutage = nextOutageMark(limiterOutage, clock.now());
          swallow(
            redis.markOccurrenceSince(
              'alert-unavailable-limiter',
              clock.now(),
              UNAVAILABLE_MARK_TTL_SECONDS,
            ),
          );
          return;
        case 'auth.mail.failed':
          swallow(
            redis.incrementWithExpiry(
              'alert-mail-consecutive-failures',
              DELIVERY_FAILURE_WINDOW_SECONDS,
            ),
          );
          return;
        case 'auth.mail.shed':
          // ISSUE-220: a count per minute, no address or task identity.
          swallow(
            redis.incrementWithExpiry(
              `alert-mail-shed-${minuteBucket(clock)}`,
              HTTP_BUCKET_TTL_SECONDS,
            ),
          );
          return;
        case 'auth.rate_limit.network_denied':
          // AUTH-3.10: a count per minute, no scope, network or client.
          swallow(
            redis.incrementWithExpiry(
              `alert-network-denied-${minuteBucket(clock)}`,
              HTTP_BUCKET_TTL_SECONDS,
            ),
          );
          return;
        case 'auth.mail.sent':
          swallow(redis.delete('alert-mail-consecutive-failures'));
          return;
        case 'retention.sweep.completed':
          swallow(
            redis.setEphemeral(
              'alert-retention-last-success',
              clock.now(),
              RETENTION_SUCCESS_TTL_SECONDS,
            ),
          );
          return;
        case 'http.request.completed':
        case 'http.request.failed':
          recordHttpOutcome(redis, clock, fields);
          return;
        default:
          return;
      }
    },
  };
}

export type AlertRecorder = ReturnType<typeof createAlertRecorder>;

/**
 * Wraps a `Logger` so every event it logs — and every event any of its
 * children log — reaches each recorder's `observe` once, first. Recorders
 * see the fields every ancestor `child` bound merged under the call's own
 * (ISSUE-173): `handleOperation` binds `operation` on its request child and
 * logs only `status` and `durationMs`, so observing the call fields alone
 * dropped every HTTP outcome. The composition root (`app.ts`) applies this
 * once with all its recorders; every existing `logger.log` call site across
 * the app (auth, retention, HTTP) feeds AUTH-7.7's alert state and metrics
 * with no per-site change.
 */
export function withAlertRecording(
  logger: Logger,
  ...recorders: ReadonlyArray<Pick<AlertRecorder, 'observe'>>
): Logger {
  const wrap = (target: Logger, bound: LogFields): Logger => ({
    log: (event, fields, message) => {
      const observed = { ...bound, ...fields };
      for (const recorder of recorders) recorder.observe(event, observed);
      target.log(event, fields, message);
    },
    child: (fields) => wrap(target.child(fields), { ...bound, ...fields }),
  });
  return wrap(logger, {});
}
