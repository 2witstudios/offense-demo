import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createMetricsStore,
  formatPrometheusMetrics,
  KNOWN_OPERATIONS,
  LATENCY_BUCKETS_MS,
} from './metrics-store';

setupRitewayBun();

describe('createMetricsStore (AUTH-7.7)', () => {
  test('buckets auth-operation completions by status class only', () => {
    const store = createMetricsStore();
    store.observe('http.request.completed', {
      operation: 'auth.request',
      status: 200,
    });
    store.observe('http.request.completed', {
      operation: 'auth.request',
      status: 204,
    });
    store.observe('http.request.failed', {
      operation: 'auth.request',
      status: 503,
    });
    store.observe('http.request.completed', {
      operation: 'auth.request',
      status: 429,
    });
    store.observe('http.request.completed', {
      operation: 'health.readiness',
      status: 500,
    });
    assert({
      given: '3 auth 2xx, 1 auth 4xx, 1 auth 5xx, and 1 non-auth 5xx',
      should:
        'count only the auth-prefixed operations, bucketed by status class',
      actual: store.snapshot().httpRequestsByStatusClass,
      expected: { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 1 },
    });
  });

  test('counts rate-limit and mail-delivery events', () => {
    const store = createMetricsStore();
    store.observe('auth.rate_limit.denied', {});
    store.observe('auth.rate_limit.denied', {});
    store.observe('auth.rate_limit.unavailable', {});
    store.observe('auth.mail.failed', {});
    store.observe('auth.mail.shed', { pending: 68 });
    store.observe('auth.mail.shed', { pending: 68 });
    store.observe('auth.rate_limit.network_denied', { scope: 'ipv6_48' });
    store.observe('auth.rate_limit.network_denied', { scope: 'ipv6_48' });
    store.observe('auth.rate_limit.network_denied', { scope: 'ipv4_24' });
    store.observe('auth.rate_limit.network_denied', { scope: 'ipv6_32' });
    assert({
      given:
        '2 denials, 1 limiter outage, 1 mail failure, 2 shed pieces of work, and network denials for two known scopes and one unknown',
      should: 'count each independently',
      actual: {
        rateLimitDeniedTotal: store.snapshot().rateLimitDeniedTotal,
        rateLimitUnavailableTotal: store.snapshot().rateLimitUnavailableTotal,
        mailDeliveryFailuresTotal: store.snapshot().mailDeliveryFailuresTotal,
        authMailShedTotal: store.snapshot().authMailShedTotal,
        networkDeniedByScope: store.snapshot().networkDeniedByScope,
      },
      expected: {
        rateLimitDeniedTotal: 2,
        rateLimitUnavailableTotal: 1,
        mailDeliveryFailuresTotal: 1,
        authMailShedTotal: 2,
        // An unknown scope is not a label: cardinality stays bounded.
        networkDeniedByScope: { ipv6_56: 0, ipv6_48: 2, ipv4_24: 1 },
      },
    });
  });

  test('buckets retention sweep failures by their own bounded target name', () => {
    const store = createMetricsStore();
    store.observe('retention.sweep.failed', { operation: 'retention.session' });
    store.observe('retention.sweep.failed', { operation: 'retention.session' });
    store.observe('retention.sweep.failed', {
      operation: 'retention.verification',
    });
    assert({
      given: 'two failures of one target and one of another',
      should: 'tally each target name separately',
      actual: store.snapshot().retentionSweepFailuresByOperation,
      expected: { 'retention.session': 2, 'retention.verification': 1 },
    });
  });

  test('ignores unrelated events', () => {
    const store = createMetricsStore();
    store.observe('auth.magic_link.verified', {});
    assert({
      given: 'an event this store does not track',
      should: 'leave every counter and histogram empty',
      actual: store.snapshot(),
      expected: {
        httpRequestsByStatusClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
        rateLimitDeniedTotal: 0,
        rateLimitUnavailableTotal: 0,
        mailDeliveryFailuresTotal: 0,
        authMailShedTotal: 0,
        networkDeniedByScope: { ipv6_56: 0, ipv6_48: 0, ipv4_24: 0 },
        retentionSweepFailuresByOperation: {},
        latencyMsByOperation: {},
      },
    });
  });

  test('observes latency into cumulative bounded buckets, by operation', () => {
    const store = createMetricsStore();
    store.observe('http.request.completed', {
      operation: 'auth.request',
      status: 200,
      durationMs: 30,
    });
    store.observe('http.request.failed', {
      operation: 'auth.request',
      status: 503,
      durationMs: 600,
    });
    const histogram = store.snapshot().latencyMsByOperation['auth.request'];
    assert({
      given: 'one 30ms success and one 600ms failure for the same operation',
      should:
        'count the 30ms sample into every bucket >= 50ms and the 600ms sample only into buckets >= 1000ms, with count/sum tracked',
      actual: histogram,
      expected: {
        bucketCounts: LATENCY_BUCKETS_MS.map(
          (boundary) => [30, 600].filter((d) => d <= boundary).length,
        ),
        count: 2,
        sum: 630,
      },
    });
  });

  test('tracks latency for every known operation, not only auth-prefixed ones', () => {
    const store = createMetricsStore();
    store.observe('http.request.completed', {
      operation: 'health.readiness',
      status: 200,
      durationMs: 10,
    });
    assert({
      given: 'a non-auth known operation',
      should: 'still record its own latency histogram',
      actual: store.snapshot().latencyMsByOperation['health.readiness']?.count,
      expected: 1,
    });
  });

  test('collapses an unknown operation into the single "other" latency label (cardinality bound)', () => {
    const store = createMetricsStore();
    for (let i = 0; i < 50; i += 1)
      store.observe('http.request.completed', {
        operation: `attacker-controlled-operation-${i}`,
        status: 200,
        durationMs: 5,
      });
    const snapshot = store.snapshot();
    assert({
      given: '50 distinct, never-before-seen operation strings',
      should:
        'never mint a new label: every one collapses into "other", so the label set stays bounded',
      actual: {
        labels: Object.keys(snapshot.latencyMsByOperation),
        otherCount: snapshot.latencyMsByOperation.other?.count,
      },
      expected: { labels: ['other'], otherCount: 50 },
    });
  });

  test('the known-operation allowlist is the closed, bounded label set', () => {
    const store = createMetricsStore();
    for (const operation of KNOWN_OPERATIONS)
      store.observe('http.request.completed', {
        operation,
        status: 200,
        durationMs: 1,
      });
    assert({
      given: 'one observation for every known operation',
      should: 'produce exactly that many labels, never more',
      actual: Object.keys(store.snapshot().latencyMsByOperation).length,
      expected: KNOWN_OPERATIONS.length,
    });
  });
});

describe('formatPrometheusMetrics (AUTH-7.7)', () => {
  test('renders one HELP/TYPE/sample line group per metric, with bounded labels', () => {
    const store = createMetricsStore();
    store.observe('http.request.completed', {
      operation: 'auth.request',
      status: 200,
    });
    store.observe('retention.sweep.failed', { operation: 'retention.session' });
    const text = formatPrometheusMetrics(store.snapshot());
    assert({
      given: 'a snapshot with one 2xx auth request and one retention failure',
      should:
        'expose Prometheus text exposition with the sample values present',
      actual: {
        hasHelp: text.includes('# HELP auth_http_requests_total'),
        hasType: text.includes('# TYPE auth_http_requests_total counter'),
        has2xxSample: text.includes(
          'auth_http_requests_total{status_class="2xx"} 1',
        ),
        hasRetentionSample: text.includes(
          'retention_sweep_failures_total{operation="retention.session"} 1',
        ),
        endsWithNewline: text.endsWith('\n'),
      },
      expected: {
        hasHelp: true,
        hasType: true,
        has2xxSample: true,
        hasRetentionSample: true,
        endsWithNewline: true,
      },
    });
  });

  test('renders the latency histogram with a bounded operation label and a +Inf bucket', () => {
    const store = createMetricsStore();
    store.observe('http.request.completed', {
      operation: 'auth.request',
      status: 200,
      durationMs: 30,
    });
    const text = formatPrometheusMetrics(store.snapshot());
    assert({
      given: 'one latency observation for a known operation',
      should:
        'expose a histogram type, one bucket line per boundary plus +Inf, and _sum/_count lines, all scoped to that operation label',
      actual: {
        hasType: text.includes(
          '# TYPE auth_http_request_duration_ms histogram',
        ),
        has50msBucket: text.includes(
          'auth_http_request_duration_ms_bucket{operation="auth.request",le="50"} 1',
        ),
        hasInfBucket: text.includes(
          'auth_http_request_duration_ms_bucket{operation="auth.request",le="+Inf"} 1',
        ),
        hasSum: text.includes(
          'auth_http_request_duration_ms_sum{operation="auth.request"} 30',
        ),
        hasCount: text.includes(
          'auth_http_request_duration_ms_count{operation="auth.request"} 1',
        ),
      },
      expected: {
        hasType: true,
        has50msBucket: true,
        hasInfBucket: true,
        hasSum: true,
        hasCount: true,
      },
    });
  });
  test('the per-client denial counter says it excludes network denials, which have their own (AUTH-3.10.2)', () => {
    const text = formatPrometheusMetrics(createMetricsStore().snapshot());
    const help = (metric: string) =>
      text.split('\n').find((line) => line.startsWith(`# HELP ${metric} `)) ??
      '';
    assert({
      given: 'the exposition of both rate-limit denial counters',
      should:
        'say auth_rate_limit_denied_total excludes network denials, and that auth_rate_limit_network_denied_total counts them',
      actual: {
        deniedExcludesNetwork: /exclud\w* network/i.test(
          help('auth_rate_limit_denied_total'),
        ),
        deniedPointsAtNetworkCounter: help(
          'auth_rate_limit_denied_total',
        ).includes('auth_rate_limit_network_denied_total'),
        networkCounterDescribed: /network/i.test(
          help('auth_rate_limit_network_denied_total'),
        ),
      },
      expected: {
        deniedExcludesNetwork: true,
        deniedPointsAtNetworkCounter: true,
        networkCounterDescribed: true,
      },
    });
  });
});
