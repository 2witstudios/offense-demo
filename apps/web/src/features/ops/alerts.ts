import type { Clock } from '@offense-demo/clock';
import type { Logger } from '@offense-demo/logger';
import {
  readAlertSnapshot,
  type AlertStateRedis,
  type LocalAlertState,
} from '../../server/alert-snapshot';
import { evaluateAlerts } from '../../server/alert-state';
import { handleOperation } from '../../server/http';
import { requireProbeToken } from './probe-auth';

/**
 * `GET /api/ops/alerts` (AUTH-7.7): a non-mutating, token-gated read of the
 * current alert-condition snapshot. The scheduled probe workflow (outside
 * this app, which cannot alert on its own outage) calls this and fires an operator
 * alert for whatever `conditions` names — on GitHub's own best-effort
 * schedule, which the owner has accepted as-is (ADR 0046, DEC-33): GitHub's
 * `schedule` trigger measures 2-5 hours apart in production, not the 5
 * minutes `auth-alerts.yml` configures, and no new scheduler is planned for
 * staging. Every field is a count or a timestamp — no email, token, or
 * client address.
 */
export function createAlertsHandler({
  logger,
  redis,
  local,
  clock,
  token,
}: {
  readonly logger: Logger;
  readonly redis: AlertStateRedis;
  /** What this process saw itself, readable when Redis is not (ISSUE-191). */
  readonly local: LocalAlertState;
  readonly clock: Clock;
  /** Read lazily per request: baseline startup never requires auth configuration (ADR 0020). */
  readonly token: () => string;
}) {
  return (request: Request) =>
    handleOperation(logger, request, 'ops.alerts', async () => {
      requireProbeToken(request, token());
      const snapshot = await readAlertSnapshot({ redis, local, clock });
      return Response.json({
        now: snapshot.nowIso,
        conditions: evaluateAlerts(snapshot),
        snapshot,
      });
    });
}
