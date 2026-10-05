import type { Logger } from '@offense-demo/logger';
import { withTimeout } from '@offense-demo/observability';
import { handleOperation } from './http';

type Probe = { readonly health: () => Promise<boolean> };

/**
 * `/api/health/ready`: ready only while not draining and while PostgreSQL
 * and Redis each answer within two seconds.
 */
export function createReadinessHandler({
  database,
  redis,
  isDraining,
  logger,
}: {
  readonly database: Probe;
  readonly redis: Probe;
  readonly isDraining: () => boolean;
  readonly logger: Logger;
}) {
  return (request: Request) =>
    handleOperation(logger, request, 'health.readiness', async () => {
      const results = await Promise.allSettled([
        withTimeout(database.health(), 2000),
        withTimeout(redis.health(), 2000),
      ]);
      const ready =
        !isDraining() &&
        results.every(
          (result) => result.status === 'fulfilled' && result.value,
        );
      return Response.json(
        { status: ready ? 'ready' : 'unavailable' },
        { status: ready ? 200 : 503 },
      );
    });
}
