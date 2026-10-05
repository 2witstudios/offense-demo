import type { Logger } from '@offense-demo/logger';
import {
  formatPrometheusMetrics,
  type MetricsStore,
} from '../../server/metrics-store';
import { handleOperation } from '../../server/http';
import { requireProbeToken } from './probe-auth';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * `GET /api/ops/metrics` (AUTH-7.7): a non-mutating, token-gated Prometheus
 * text-exposition endpoint for latency-adjacent request counts, 5xx, rate
 * limiting, delivery failures and job failures — the bounded-cardinality
 * dashboard source the leaf asks for. Per-process counters (Prometheus's
 * own convention: a scraper aggregates across instances and restarts).
 * Wiring an actual dashboard/scrape config is a deploy-rail change outside
 * this endpoint's scope (see the AUTH-7.7 ADR and handoff).
 */
export function createMetricsHandler({
  logger,
  metrics,
  token,
}: {
  readonly logger: Logger;
  readonly metrics: MetricsStore;
  /** Read lazily per request: baseline startup never requires auth configuration (ADR 0020). */
  readonly token: () => string;
}) {
  return (request: Request) =>
    handleOperation(logger, request, 'ops.metrics', async () => {
      requireProbeToken(request, token());
      return new Response(formatPrometheusMetrics(metrics.snapshot()), {
        headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE },
      });
    });
}
