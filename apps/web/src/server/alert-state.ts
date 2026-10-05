/**
 * AUTH-7.7's alert thresholds, snapshot shape and pure evaluation. Reading
 * the snapshot from Redis lives in `alert-snapshot.ts`.
 */
export const MINUTE_MS = 60_000;

/**
 * The AUTH-7.7 alert thresholds, named once so `evaluateAlerts` and its
 * tests read the same numbers the runbook documents
 * (`docs/operations/auth-delivery.md`).
 */
export const ALERT_THRESHOLDS = {
  unavailableMs: 2 * MINUTE_MS,
  consecutiveDeliveryFailures: 3,
  auth5xxWindowMinutes: 10,
  auth5xxMinRequests: 100,
  auth5xxRate: 0.01,
  retentionMissedMs: 2 * 60 * MINUTE_MS,
  /**
   * ISSUE-220: handed-off auth mail work shed past its bound (512 holding
   * a slot, 64 waiting; DEC-73, DEC-76) over the trailing window. A
   * saturated minute with some real sign-in traffic can shed a stray task,
   * so it fires on a sustained count, 20 in 10 minutes, well below what any
   * flood that fills the bound sheds (every request past the 576 held or
   * waiting).
   */
  mailShedWindowMinutes: 10,
  mailShedCount: 20,
  /**
   * AUTH-3.10: magic-link requests denied for their network (IPv6 /56 or
   * /48, IPv4 /24) over the trailing window. A network over its limit is
   * already refused, so this is for operators to see a flood, not to stop
   * it: 300 in 10 minutes is more than a busy shared network trips by
   * accident (each allows 30 to 120 a minute) and far less than a single
   * /48 flooding at full rate (about 196,000 a minute).
   */
  networkDeniedWindowMinutes: 10,
  networkDeniedCount: 300,
} as const;

export type AlertSnapshot = {
  readonly nowIso: string;
  /**
   * Whether the Redis-backed markers below were read. `unreachable` leaves
   * them at their empty values, which `evaluateAlerts` then ignores
   * (ISSUE-191).
   */
  readonly redisState: 'read' | 'unreachable';
  readonly storageUnavailableSinceIso: string | null;
  readonly limiterUnavailableSinceIso: string | null;
  readonly deliveryConsecutiveFailures: number;
  readonly authRequests: {
    readonly total: number;
    readonly serverErrors: number;
    readonly windowMinutes: number;
  };
  readonly retentionLastSuccessIso: string | null;
  /** `auth.mail.shed` events over the trailing window (ISSUE-220). */
  readonly mailShed: {
    readonly count: number;
    readonly windowMinutes: number;
  };
  /** `auth.rate_limit.network_denied` events over the trailing window (AUTH-3.10). */
  readonly networkDenied: {
    readonly count: number;
    readonly windowMinutes: number;
  };
};

type AlertConditionId =
  | 'storage_unavailable'
  | 'limiter_unavailable'
  | 'delivery_failures'
  | 'auth_5xx_rate'
  | 'cleanup_missed'
  | 'mail_shed'
  | 'network_limited';

export type AlertCondition = {
  readonly id: AlertConditionId;
  readonly summary: string;
  readonly runbook: string;
};

const RUNBOOK_ANCHOR = {
  storage_unavailable: '#storage-or-rate-limiter-unavailable',
  limiter_unavailable: '#storage-or-rate-limiter-unavailable',
  delivery_failures: '#delivery-provider-failing-repeatedly',
  auth_5xx_rate: '#auth-5xx-error-rate-elevated',
  cleanup_missed: '#retention-cleanup-missed',
  mail_shed: '#auth-mail-shed-past-the-bound',
  network_limited: '#magic-link-requests-limited-per-network',
} as const satisfies Record<AlertConditionId, string>;

const runbook = (id: AlertConditionId) =>
  `docs/operations/auth-delivery.md${RUNBOOK_ANCHOR[id]}`;

const elapsedMs = (sinceIso: string, nowIso: string): number =>
  Date.parse(nowIso) - Date.parse(sinceIso);

const checkStorageUnavailable = (
  snapshot: AlertSnapshot,
): AlertCondition | undefined =>
  snapshot.storageUnavailableSinceIso !== null &&
  elapsedMs(snapshot.storageUnavailableSinceIso, snapshot.nowIso) >=
    ALERT_THRESHOLDS.unavailableMs
    ? {
        id: 'storage_unavailable',
        summary: `Session/database storage unavailable since ${snapshot.storageUnavailableSinceIso}`,
        runbook: runbook('storage_unavailable'),
      }
    : undefined;

const checkLimiterUnavailable = (
  snapshot: AlertSnapshot,
): AlertCondition | undefined =>
  snapshot.limiterUnavailableSinceIso !== null &&
  elapsedMs(snapshot.limiterUnavailableSinceIso, snapshot.nowIso) >=
    ALERT_THRESHOLDS.unavailableMs
    ? {
        id: 'limiter_unavailable',
        summary: `Auth rate limiter unavailable since ${snapshot.limiterUnavailableSinceIso}`,
        runbook: runbook('limiter_unavailable'),
      }
    : undefined;

const checkDeliveryFailures = (
  snapshot: AlertSnapshot,
): AlertCondition | undefined =>
  snapshot.deliveryConsecutiveFailures >=
  ALERT_THRESHOLDS.consecutiveDeliveryFailures
    ? {
        id: 'delivery_failures',
        summary: `${snapshot.deliveryConsecutiveFailures} consecutive mail delivery failures`,
        runbook: runbook('delivery_failures'),
      }
    : undefined;

const checkAuth5xxRate = (
  snapshot: AlertSnapshot,
): AlertCondition | undefined => {
  const { total, serverErrors, windowMinutes } = snapshot.authRequests;
  if (
    total < ALERT_THRESHOLDS.auth5xxMinRequests ||
    serverErrors / total <= ALERT_THRESHOLDS.auth5xxRate
  )
    return undefined;
  return {
    id: 'auth_5xx_rate',
    summary: `Auth 5xx rate ${((serverErrors / total) * 100).toFixed(2)}% over ${windowMinutes}m (${serverErrors}/${total} requests)`,
    runbook: runbook('auth_5xx_rate'),
  };
};

const checkCleanupMissed = (
  snapshot: AlertSnapshot,
): AlertCondition | undefined =>
  snapshot.retentionLastSuccessIso === null ||
  elapsedMs(snapshot.retentionLastSuccessIso, snapshot.nowIso) >=
    ALERT_THRESHOLDS.retentionMissedMs
    ? {
        id: 'cleanup_missed',
        summary:
          snapshot.retentionLastSuccessIso === null
            ? 'Retention sweep has not completed successfully since boot'
            : `Retention sweep last succeeded ${snapshot.retentionLastSuccessIso}`,
        runbook: runbook('cleanup_missed'),
      }
    : undefined;

const checkMailShed = (snapshot: AlertSnapshot): AlertCondition | undefined =>
  snapshot.mailShed.count >= ALERT_THRESHOLDS.mailShedCount
    ? {
        id: 'mail_shed',
        summary: `${snapshot.mailShed.count} handed-off auth mail tasks shed in ${snapshot.mailShed.windowMinutes}m: sign-in and sign-up mail is being dropped`,
        runbook: runbook('mail_shed'),
      }
    : undefined;

const checkNetworkLimited = (
  snapshot: AlertSnapshot,
): AlertCondition | undefined =>
  snapshot.networkDenied.count >= ALERT_THRESHOLDS.networkDeniedCount
    ? {
        id: 'network_limited',
        summary: `${snapshot.networkDenied.count} magic-link requests denied for their network in ${snapshot.networkDenied.windowMinutes}m: one network is flooding sign-in`,
        runbook: runbook('network_limited'),
      }
    : undefined;

type AlertCheck = (snapshot: AlertSnapshot) => AlertCondition | undefined;

const ALERT_CHECKS: readonly AlertCheck[] = [
  checkStorageUnavailable,
  checkLimiterUnavailable,
  checkDeliveryFailures,
  checkAuth5xxRate,
  checkCleanupMissed,
  checkMailShed,
  checkNetworkLimited,
];

/** The one check whose state this process keeps without Redis (ISSUE-191). */
const IN_PROCESS_CHECKS: readonly AlertCheck[] = [checkLimiterUnavailable];

/**
 * AUTH-7.7's four alert conditions, evaluated from a snapshot the caller
 * already read (`readAlertSnapshot` in `alert-snapshot.ts`). Pure: every threshold and duration
 * decision is a function of the inputs, so this is fully testable without
 * Redis, a clock, or the network.
 */
export function evaluateAlerts(
  snapshot: AlertSnapshot,
): readonly AlertCondition[] {
  const checks =
    snapshot.redisState === 'read' ? ALERT_CHECKS : IN_PROCESS_CHECKS;
  return checks
    .map((check) => check(snapshot))
    .filter(
      (condition): condition is AlertCondition => condition !== undefined,
    );
}
