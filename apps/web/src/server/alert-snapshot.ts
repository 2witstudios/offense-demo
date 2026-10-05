/**
 * Reads the Redis-backed alert markers `alert-recorder.ts` writes into one
 * `AlertSnapshot` for `evaluateAlerts` (`alert-state.ts`), bounded per read
 * and degrading to an `unreachable` snapshot (ISSUE-191, ISSUE-208).
 */
import { withTimeout } from '@offense-demo/observability';
import { ALERT_THRESHOLDS, MINUTE_MS, type AlertSnapshot } from './alert-state';

/**
 * Each Redis read behind `/api/ops/alerts` is abandoned after this long,
 * the same budget readiness gives its PING, so a Redis that stops
 * answering yields a `redisState: 'unreachable'` snapshot instead of a
 * request that never ends (ISSUE-208). Bounded per command, not by the
 * client's own defaults, which leave a stalled connection pending.
 */
export const ALERT_STATE_READ_TIMEOUT_MS = 2_000;

export type AlertStateRedis = {
  readonly get: (key: string) => Promise<string | null>;
};

export type AlertClock = { readonly now: () => string };

/** The alert state this process keeps itself (`alert-recorder.ts`). */
export type LocalAlertState = {
  readonly limiterUnavailableSince: () => string | null;
};

const earlierOf = (left: string | null, right: string | null) =>
  left === null || (right !== null && right < left) ? right : left;

const HTTP_TOTAL_KEY = (bucket: number) => `alert-http-total-${bucket}`;
const HTTP_5XX_KEY = (bucket: number) => `alert-http-5xx-${bucket}`;
const MAIL_SHED_KEY = (bucket: number) => `alert-mail-shed-${bucket}`;
const NETWORK_DENIED_KEY = (bucket: number) => `alert-network-denied-${bucket}`;

/**
 * Reads the durable, bounded-cardinality Redis state `alert-recorder.ts`
 * writes and assembles it into one snapshot `evaluateAlerts` can decide
 * from. Per-minute request buckets (`http.ts`'s `status` field, tapped for
 * `operation` values starting with `auth.`) are summed over the trailing
 * `windowMinutes` window.
 */
export async function readAlertSnapshot({
  redis,
  local,
  clock,
  windowMinutes = ALERT_THRESHOLDS.auth5xxWindowMinutes,
  readTimeoutMs = ALERT_STATE_READ_TIMEOUT_MS,
}: {
  readonly redis: AlertStateRedis;
  readonly local: LocalAlertState;
  readonly clock: AlertClock;
  readonly windowMinutes?: number;
  readonly readTimeoutMs?: number;
}): Promise<AlertSnapshot> {
  const nowIso = clock.now();
  const localLimiterSince = local.limiterUnavailableSince();
  try {
    const read = await readRedisMarkers(
      { get: (key) => withTimeout(redis.get(key), readTimeoutMs) },
      nowIso,
      windowMinutes,
    );
    return {
      ...read,
      limiterUnavailableSinceIso: earlierOf(
        read.limiterUnavailableSinceIso,
        localLimiterSince,
      ),
    };
  } catch {
    // The limiter shares this Redis: its outage must still be reportable
    // from what this process saw (ISSUE-191).
    return {
      nowIso,
      redisState: 'unreachable',
      storageUnavailableSinceIso: null,
      limiterUnavailableSinceIso: localLimiterSince,
      deliveryConsecutiveFailures: 0,
      authRequests: { total: 0, serverErrors: 0, windowMinutes },
      retentionLastSuccessIso: null,
      mailShed: {
        count: 0,
        windowMinutes: ALERT_THRESHOLDS.mailShedWindowMinutes,
      },
      networkDenied: {
        count: 0,
        windowMinutes: ALERT_THRESHOLDS.networkDeniedWindowMinutes,
      },
    };
  }
}

const sumOf = (values: readonly (string | null)[]) =>
  values.reduce((sum, value) => sum + Number(value ?? 0), 0);

async function readRedisMarkers(
  redis: AlertStateRedis,
  nowIso: string,
  windowMinutes: number,
): Promise<AlertSnapshot> {
  const currentBucket = Math.floor(Date.parse(nowIso) / MINUTE_MS);
  const trailing = (minutes: number) =>
    Array.from({ length: minutes }, (_, index) => currentBucket - index);
  const buckets = trailing(windowMinutes);
  const shedBuckets = trailing(ALERT_THRESHOLDS.mailShedWindowMinutes);
  const networkBuckets = trailing(ALERT_THRESHOLDS.networkDeniedWindowMinutes);
  const [
    storageSince,
    limiterSince,
    mailFailures,
    retentionLastSuccess,
    shedValues,
    networkValues,
    ...bucketValues
  ] = await Promise.all([
    redis.get('alert-unavailable-storage'),
    redis.get('alert-unavailable-limiter'),
    redis.get('alert-mail-consecutive-failures'),
    redis.get('alert-retention-last-success'),
    Promise.all(shedBuckets.map((bucket) => redis.get(MAIL_SHED_KEY(bucket)))),
    Promise.all(
      networkBuckets.map((bucket) => redis.get(NETWORK_DENIED_KEY(bucket))),
    ),
    ...buckets.flatMap((bucket) => [
      redis.get(HTTP_TOTAL_KEY(bucket)),
      redis.get(HTTP_5XX_KEY(bucket)),
    ]),
  ]);
  let total = 0;
  let serverErrors = 0;
  for (let index = 0; index < bucketValues.length; index += 2) {
    total += Number(bucketValues[index] ?? 0);
    serverErrors += Number(bucketValues[index + 1] ?? 0);
  }
  return {
    nowIso,
    redisState: 'read',
    storageUnavailableSinceIso: storageSince,
    limiterUnavailableSinceIso: limiterSince,
    deliveryConsecutiveFailures: Number(mailFailures ?? 0),
    authRequests: { total, serverErrors, windowMinutes },
    retentionLastSuccessIso: retentionLastSuccess,
    mailShed: {
      count: sumOf(shedValues),
      windowMinutes: ALERT_THRESHOLDS.mailShedWindowMinutes,
    },
    networkDenied: {
      count: sumOf(networkValues),
      windowMinutes: ALERT_THRESHOLDS.networkDeniedWindowMinutes,
    },
  };
}
