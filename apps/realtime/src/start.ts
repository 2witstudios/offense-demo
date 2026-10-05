import { systemClock } from '@offense-demo/clock';
import {
  drainWithDeadline,
  installShutdownSignals,
} from '@offense-demo/observability';
import { createRealtimeApp } from './app';
import { DEFAULT_REALTIME_PORT, parsePort } from './port';
import { serveRealtime } from './serve';

// Unlike apps/web (whose "dev" task runs `next dev`, a different process
// that never touches this file), this is the only entrypoint apps/realtime
// has: "dev" and "start" both run it, differing only in NODE_ENV, which
// `readRealtimeConfig` uses to decide how strictly to validate. There is no
// production-only guard here for that reason.
//
// This is realtime's process edge: the only module that reads process.env.
// It builds the one app this process runs; everything else receives it.
const resources = createRealtimeApp({
  env: process.env,
  clock: systemClock,
});
const port = parsePort(process.env.REALTIME_PORT, DEFAULT_REALTIME_PORT);

// `serveRealtime` awaits startup order (ADR 0032 §2: LISTEN, then the
// high-water mark) before `Bun.serve` accepts sockets. The sink is a no-op
// seam here: fan-out to subscribed sockets is RT-2.3c.
const { server, drain } = await serveRealtime({
  resources,
  port,
  sink: () => {},
});
resources.logger.log(
  'server.start',
  { operation: 'server.start', port },
  'Server listening',
);

/**
 * Stops accepting new HTTP and WebSocket connections, then the drain loop's
 * LISTEN subscription and the database and Redis pools. It does not close
 * already-open sockets with `4006 server_restarting`: that is owned by
 * RT-2.3d, once the connection registry (RT-2.3c) exists for it to iterate.
 */
async function shutdown() {
  if (resources.isDraining()) return;
  resources.drain();
  resources.logger.log(
    'server.shutdown',
    { operation: 'server.shutdown' },
    'Draining requests',
  );
  await drainWithDeadline({
    deadlineMs: 25_000,
    onDeadlineExceeded: () => process.exit(1),
    close: async () => {
      await server.stop();
      await drain.stop();
      await resources.close();
    },
  });
}
installShutdownSignals(shutdown);
