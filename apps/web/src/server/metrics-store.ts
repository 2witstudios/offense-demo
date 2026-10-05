const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];

/** Fixed latency buckets, in milliseconds (Prometheus `le` boundaries). */
export const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500] as const;

/**
 * The bounded, closed set of operation names any `handleOperation` call
 * site passes today (grep-verified across `apps/web/src`). A latency
 * observation for any other string — a bug, a future call site added
 * without updating this list, or an attacker-influenced value — collapses
 * into `OTHER_OPERATION_LABEL` instead of minting a new label, so this
 * histogram's cardinality can never grow past `KNOWN_OPERATIONS.length + 1`.
 */
export const KNOWN_OPERATIONS = [
  'auth.request',
  'auth.confirm.view',
  'auth.confirm.submit',
  'auth.confirm_email.view',
  'auth.confirm_email.submit',
  'auth.mail.webhook',
  'account.sessions.list',
  'account.sessions.revoke',
  'account.username.claim',
  'realtime.ticket.issue',
  'health.readiness',
  'ops.alerts',
  'ops.metrics',
] as const;
const OTHER_OPERATION_LABEL = 'other';
type OperationLabel =
  (typeof KNOWN_OPERATIONS)[number] | typeof OTHER_OPERATION_LABEL;

const operationLabelFor = (operation: string): OperationLabel =>
  (KNOWN_OPERATIONS as readonly string[]).includes(operation)
    ? (operation as OperationLabel)
    : OTHER_OPERATION_LABEL;

type LatencyHistogramSnapshot = {
  /** Cumulative counts, one per `LATENCY_BUCKETS_MS` boundary (observations <= that boundary). */
  readonly bucketCounts: readonly number[];
  readonly count: number;
  readonly sum: number;
};

type LatencyHistogram = {
  readonly bucketCounts: number[];
  count: number;
  sum: number;
};

const emptyHistogram = (): LatencyHistogram => ({
  bucketCounts: LATENCY_BUCKETS_MS.map(() => 0),
  count: 0,
  sum: 0,
});

export type MetricsSnapshot = {
  readonly httpRequestsByStatusClass: Readonly<Record<StatusClass, number>>;
  readonly rateLimitDeniedTotal: number;
  readonly rateLimitUnavailableTotal: number;
  readonly mailDeliveryFailuresTotal: number;
  /** Saturated sign-in/sign-up work shed past its bound (ISSUE-185, DEC-73). */
  readonly authMailShedTotal: number;
  /** Magic-link requests denied for their network, by scope (AUTH-3.10). */
  readonly networkDeniedByScope: Readonly<Record<NetworkScopeLabel, number>>;
  /** Keyed by `retention-sweep.ts`'s own target names — a small, fixed set, never arbitrary input. */
  readonly retentionSweepFailuresByOperation: Readonly<Record<string, number>>;
  /** Keyed by the bounded `OperationLabel` set (`KNOWN_OPERATIONS` plus "other"). */
  readonly latencyMsByOperation: Readonly<
    Record<string, LatencyHistogramSnapshot>
  >;
};

/** The network scopes `rate-limit.ts` limits: the only labels counted. */
const NETWORK_SCOPES = ['ipv6_56', 'ipv6_48', 'ipv4_24'] as const;
type NetworkScopeLabel = (typeof NETWORK_SCOPES)[number];
const isNetworkScope = (value: unknown): value is NetworkScopeLabel =>
  (NETWORK_SCOPES as readonly unknown[]).includes(value);

const statusClassOf = (status: number): StatusClass | undefined =>
  STATUS_CLASSES.find((cls) => cls[0] === String(Math.floor(status / 100)));

/**
 * AUTH-7.7's bounded-cardinality dashboard source: in-memory, per-process
 * counters over the same structured event stream `alert-recorder.ts` reads,
 * fed by the same `withAlertRecording` tap. Every label comes from a small,
 * known set (a status-code class, or one of `retentionTargets`' own target
 * names) — never an email, token, IP, or other unbounded value.
 */
export function createMetricsStore() {
  const httpRequestsByStatusClass: Record<StatusClass, number> = {
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
  };
  let rateLimitDeniedTotal = 0;
  let rateLimitUnavailableTotal = 0;
  let mailDeliveryFailuresTotal = 0;
  let authMailShedTotal = 0;
  const networkDeniedByScope: Record<NetworkScopeLabel, number> = {
    ipv6_56: 0,
    ipv6_48: 0,
    ipv4_24: 0,
  };
  const retentionSweepFailuresByOperation = new Map<string, number>();
  const latencyByOperation = new Map<OperationLabel, LatencyHistogram>();

  const recordStatusClass = (fields: Readonly<Record<string, unknown>>) => {
    const { operation, status } = fields;
    if (typeof operation !== 'string' || !operation.startsWith('auth.')) return;
    if (typeof status !== 'number') return;
    const cls = statusClassOf(status);
    if (cls) httpRequestsByStatusClass[cls] += 1;
  };

  const recordLatency = (fields: Readonly<Record<string, unknown>>) => {
    const { operation, durationMs } = fields;
    if (typeof operation !== 'string' || typeof durationMs !== 'number') return;
    const label = operationLabelFor(operation);
    const histogram = latencyByOperation.get(label) ?? emptyHistogram();
    const bucketCounts = LATENCY_BUCKETS_MS.map((boundary, index) => {
      const current = histogram.bucketCounts[index] ?? 0;
      return durationMs <= boundary ? current + 1 : current;
    });
    latencyByOperation.set(label, {
      bucketCounts,
      count: histogram.count + 1,
      sum: histogram.sum + durationMs,
    });
  };

  const recordHttpOutcome = (fields: Readonly<Record<string, unknown>>) => {
    recordStatusClass(fields);
    recordLatency(fields);
  };

  const recordRetentionFailure = (
    fields: Readonly<Record<string, unknown>>,
  ) => {
    const operation = fields.operation;
    if (typeof operation !== 'string') return;
    retentionSweepFailuresByOperation.set(
      operation,
      (retentionSweepFailuresByOperation.get(operation) ?? 0) + 1,
    );
  };

  return {
    observe(event: string, fields: Readonly<Record<string, unknown>>): void {
      switch (event) {
        case 'http.request.completed':
        case 'http.request.failed':
          recordHttpOutcome(fields);
          return;
        case 'auth.rate_limit.denied':
          rateLimitDeniedTotal += 1;
          return;
        case 'auth.rate_limit.unavailable':
          rateLimitUnavailableTotal += 1;
          return;
        case 'auth.mail.failed':
          mailDeliveryFailuresTotal += 1;
          return;
        case 'auth.mail.shed':
          authMailShedTotal += 1;
          return;
        case 'auth.rate_limit.network_denied':
          if (isNetworkScope(fields.scope))
            networkDeniedByScope[fields.scope] += 1;
          return;
        case 'retention.sweep.failed':
          recordRetentionFailure(fields);
          return;
        default:
          return;
      }
    },
    snapshot(): MetricsSnapshot {
      return {
        httpRequestsByStatusClass: { ...httpRequestsByStatusClass },
        rateLimitDeniedTotal,
        rateLimitUnavailableTotal,
        mailDeliveryFailuresTotal,
        authMailShedTotal,
        networkDeniedByScope: { ...networkDeniedByScope },
        retentionSweepFailuresByOperation: Object.fromEntries(
          retentionSweepFailuresByOperation,
        ),
        latencyMsByOperation: Object.fromEntries(
          [...latencyByOperation.entries()].map(([label, histogram]) => [
            label,
            {
              bucketCounts: [...histogram.bucketCounts],
              count: histogram.count,
              sum: histogram.sum,
            },
          ]),
        ),
      };
    },
  };
}

export type MetricsStore = ReturnType<typeof createMetricsStore>;

/**
 * Prometheus text exposition (0.0.4): the format Fly's `[metrics]` scrape
 * config and any Prometheus-compatible dashboard already understand, with
 * no new client library. See the AUTH-7.7 ADR for why this shape and not a
 * new vendor SDK.
 */
export function formatPrometheusMetrics(snapshot: MetricsSnapshot): string {
  const lines: string[] = [
    '# HELP auth_http_requests_total Auth-route HTTP responses by status class since process start.',
    '# TYPE auth_http_requests_total counter',
    ...STATUS_CLASSES.map(
      (cls) =>
        `auth_http_requests_total{status_class="${cls}"} ${snapshot.httpRequestsByStatusClass[cls]}`,
    ),
    '# HELP auth_rate_limit_denied_total Auth requests denied by a per-client or per-recipient rate limit (429) since process start; excludes network denials, which auth_rate_limit_network_denied_total counts.',
    '# TYPE auth_rate_limit_denied_total counter',
    `auth_rate_limit_denied_total ${snapshot.rateLimitDeniedTotal}`,
    '# HELP auth_rate_limit_unavailable_total Auth requests the rate limiter could not decide since process start.',
    '# TYPE auth_rate_limit_unavailable_total counter',
    `auth_rate_limit_unavailable_total ${snapshot.rateLimitUnavailableTotal}`,
    '# HELP auth_mail_delivery_failures_total Auth email delivery failures since process start.',
    '# TYPE auth_mail_delivery_failures_total counter',
    `auth_mail_delivery_failures_total ${snapshot.mailDeliveryFailuresTotal}`,
    '# HELP auth_mail_shed_total Auth mail work shed after the answer because its backlog was full, since process start.',
    '# TYPE auth_mail_shed_total counter',
    `auth_mail_shed_total ${snapshot.authMailShedTotal}`,
    '# HELP auth_rate_limit_network_denied_total Magic-link requests denied for their network (IPv6 /56 or /48, IPv4 /24) since process start.',
    '# TYPE auth_rate_limit_network_denied_total counter',
    ...NETWORK_SCOPES.map(
      (scope) =>
        `auth_rate_limit_network_denied_total{scope="${scope}"} ${snapshot.networkDeniedByScope[scope]}`,
    ),
    '# HELP retention_sweep_failures_total Retention sweep failures by target since process start.',
    '# TYPE retention_sweep_failures_total counter',
    ...Object.entries(snapshot.retentionSweepFailuresByOperation).map(
      ([operation, count]) =>
        `retention_sweep_failures_total{operation="${operation}"} ${count}`,
    ),
    '# HELP auth_http_request_duration_ms Request latency in milliseconds by operation, bounded buckets.',
    '# TYPE auth_http_request_duration_ms histogram',
    ...Object.entries(snapshot.latencyMsByOperation).flatMap(
      ([operation, histogram]) => formatLatencyHistogram(operation, histogram),
    ),
  ];
  return lines.join('\n') + '\n';
}

const formatLatencyHistogram = (
  operation: string,
  histogram: LatencyHistogramSnapshot,
): string[] => [
  ...LATENCY_BUCKETS_MS.map(
    (boundary, index) =>
      `auth_http_request_duration_ms_bucket{operation="${operation}",le="${boundary}"} ${histogram.bucketCounts[index] ?? 0}`,
  ),
  `auth_http_request_duration_ms_bucket{operation="${operation}",le="+Inf"} ${histogram.count}`,
  `auth_http_request_duration_ms_sum{operation="${operation}"} ${histogram.sum}`,
  `auth_http_request_duration_ms_count{operation="${operation}"} ${histogram.count}`,
];
