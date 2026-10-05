import { refuseSchemaAlteringRole } from '@offense-demo/db';
import type { RealtimeApp } from './app';
import { createRealtimeServer } from './server';
import {
  startOutboxDrain,
  type IntervalTimers,
  type OutboxDrainControl,
  type OutboxRowsSink,
} from './outbox-drain';

/**
 * Wires startup order (ADR 0032 §2) around `Bun.serve`: production first
 * refuses a schema-altering role (ISSUE-101), then `startOutboxDrain` is
 * awaited (LISTEN, then the high-water mark), and only then does
 * `Bun.serve` accept sockets, with the drain loop's own cursor wired into
 * readiness as `outbox` (ADR 0031/0032's "delivery lag exposed for
 * readiness"). Shared by `start.ts` (the process edge) and the integration
 * suite's own real Bun.serve boot, so the two never drift apart.
 */
export async function serveRealtime({
  resources,
  port,
  hostname = '0.0.0.0',
  sink,
  pollIntervalMs,
  timers,
  onQuery,
  onListenWake,
  serve = Bun.serve,
}: {
  readonly resources: RealtimeApp;
  readonly port: number;
  readonly hostname?: string;
  readonly sink: OutboxRowsSink;
  readonly pollIntervalMs?: number;
  readonly timers?: IntervalTimers;
  readonly onQuery?: () => void;
  /** Test seam only (RT-2.3b-f1 criterion 2): observes a reconnect independent of database content or other listeners' traffic. */
  readonly onListenWake?: () => void;
  /** Test seam only (RT-2.3b review finding 2): proves sockets are never accepted before `startOutboxDrain` resolves. */
  readonly serve?: typeof Bun.serve;
}): Promise<{
  readonly server: ReturnType<typeof Bun.serve>;
  readonly drain: OutboxDrainControl;
}> {
  // Production refuses a DATABASE_URL role that could create or alter schema
  // objects before LISTEN or any socket is accepted (ISSUE-101).
  await refuseSchemaAlteringRole(resources, 'offense_demo_realtime');
  const drain = await startOutboxDrain({
    database: resources.database,
    sink,
    logger: resources.logger,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(timers === undefined ? {} : { timers }),
    ...(onQuery === undefined ? {} : { onQuery }),
    ...(onListenWake === undefined ? {} : { onListenWake }),
  });
  const { fetch, websocket } = createRealtimeServer({
    resources: {
      ...resources,
      outbox: {
        cursor: drain.cursor,
        highWaterMark: resources.database.readOutboxHighWaterMark,
      },
    },
  });
  const server = serve({ hostname, port, fetch, websocket });
  return { server, drain };
}
