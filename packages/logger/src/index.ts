import pino from 'pino';

export const eventRegistry = {
  'runtime.initialize': 'info',
  'request.unhandled': 'error',
  'http.request.completed': 'info',
  'http.request.cancelled': 'warn',
  'http.request.failed': 'error',
  'invariant.violated': 'error',
  'auth.rate_limit.denied': 'warn',
  'auth.rate_limit.unavailable': 'error',
  'auth.rate_limit.network_denied': 'warn',
  'auth.session.unavailable': 'error',
  'auth.mail.sent': 'info',
  'auth.mail.failed': 'error',
  'auth.mail.receipt_failed': 'error',
  'auth.mail.suppressed': 'info',
  'auth.mail.shed': 'warn',
  'auth.mail.abandoned': 'error',
  'auth.magic_link.verified': 'info',
  'auth.passkey.enrolled': 'info',
  'auth.passkey.authenticated': 'info',
  'auth.passkey.removed': 'info',
  'auth.passkey.notification_failed': 'error',
  'auth.session.revoked': 'info',
  'auth.session.revoked_all': 'info',
  'auth.email_change.requested': 'info',
  'auth.email_change.verified': 'info',
  'auth.email_change.cleanup_failed': 'error',
  'authz.denied': 'info',
  'realtime.outbox.append_failed': 'error',
  'realtime.outbox.drain_failed': 'error',
  'realtime.outbox.delivery_lag_estimated': 'info',
  'realtime.connection.rejected': 'info',
  'db.query.failed': 'error',
  'retention.sweep.completed': 'info',
  'retention.sweep.failed': 'error',
  'redis.command.failed': 'error',
  'server.start': 'info',
  'server.ready': 'info',
  'server.shutdown': 'info',
  'ingress.trusted_proxy.unresolved': 'warn',
  'telemetry.unknown_event': 'warn',
} as const satisfies Record<string, 'info' | 'warn' | 'error'>;

export type EventName = keyof typeof eventRegistry;
export type LogFields = Readonly<Record<string, unknown>> & {
  readonly event?: never;
};
// Mirrors packages/config's LOG_LEVEL enum. The logger's only runtime
// dependency is pino (@offense-demo/config is a test-only devDependency, for the
// redaction tests' secret keys), so the literal union is kept in sync here
// rather than imported.
export type LogLevel =
  'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type Logger = {
  log: (event: EventName, fields: LogFields, message: string) => void;
  child: (fields: LogFields) => Logger;
};
const eventNames = new Set<EventName>(
  Object.keys(eventRegistry) as EventName[],
);
const normalizeEvent = (event: string): EventName =>
  eventNames.has(event as EventName)
    ? (event as EventName)
    : 'telemetry.unknown_event';

/**
 * What a field value may be, by kind (ADR 0019). No kind admits an object,
 * an array, whitespace or a URL scheme, so a nested secret, a header pair,
 * a Bearer value or a credential URL cannot pass as any of them.
 */
const fieldKinds = {
  /** An operation name, error code or enum literal. */
  code: (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value),
  /** A request, trace, principal or provider identifier. */
  id: (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
  /** A route pattern or URL path, never a query or fragment. */
  path: (value: unknown) =>
    typeof value === 'string' && /^\/[A-Za-z0-9_./[\]-]{0,199}$/.test(value),
  /** A SHA3-256 hex digest. */
  hash: (value: unknown) =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
  /** A non-negative integer: a duration, status, port or tally. */
  count: (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0,
} as const;
type FieldKind = keyof typeof fieldKinds;

/**
 * The only fields a log line may carry, each with the kind its value must
 * have; ADR 0019 holds the same table and a drift guard compares them.
 * Anything else, or a listed field of another kind, is left out.
 */
export const loggableFields = {
  operation: 'code',
  errorCode: 'code',
  source: 'code',
  sourceLevel: 'code',
  closeReason: 'code',
  cause: 'code',
  invariantId: 'code',
  requestId: 'id',
  traceId: 'id',
  userId: 'id',
  providerMessageId: 'id',
  route: 'path',
  path: 'path',
  clientIdHash: 'hash',
  durationMs: 'count',
  status: 'count',
  port: 'count',
  deleted: 'count',
  batches: 'count',
  closeCode: 'count',
  deliverySeqLagEstimate: 'count',
  pending: 'count',
  scope: 'code',
  denyReason: 'code',
} as const satisfies Record<string, FieldKind>;

const CENSOR = '[REDACTED]';
/**
 * Fixed prose: short words of letters and light punctuation, with no digit,
 * URL, assignment or long run a credential would need.
 */
const isProse = (message: string) =>
  /^[A-Za-z][A-Za-z ,.;'()_-]{0,159}$/.test(message) &&
  message.split(/[ ,;()]+/).every((word) => word.length <= 24);

/**
 * Reads only the allowlisted names, as own data properties, so no getter
 * runs and no nested value is walked: a deep, circular, shared or hostile
 * structure costs one lookup per listed name and can never throw.
 */
const admit = (fields: unknown): Record<string, string | number> => {
  const admitted: Record<string, string | number> = {};
  if (fields === null || typeof fields !== 'object') return admitted;
  for (const [name, kind] of Object.entries(loggableFields)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(fields, name);
    } catch {
      continue;
    }
    const value: unknown = descriptor?.value;
    if (fieldKinds[kind](value)) admitted[name] = value as string | number;
  }
  return admitted;
};
export function createLogger({
  service,
  level = 'info',
  appVersion = 'development',
  gitCommit = 'unknown',
  destination,
}: {
  service: string;
  level?: LogLevel;
  appVersion?: string;
  gitCommit?: string;
  destination?: { write: (text: string) => void };
}): Logger {
  const options = { level, base: { service, appVersion, gitCommit } };
  const instance = destination ? pino(options, destination) : pino(options);
  const wrap = (logger: pino.Logger): Logger => ({
    log: (event, fields, message) => {
      const normalizedEvent = normalizeEvent(event);
      logger[eventRegistry[normalizedEvent]](
        { ...admit(fields), event: normalizedEvent },
        typeof message === 'string' && isProse(message) ? message : CENSOR,
      );
    },
    child: (fields) => wrap(logger.child(admit(fields))),
  });
  return wrap(instance);
}
