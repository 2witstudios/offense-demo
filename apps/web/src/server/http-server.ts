import { createServer, type Server } from 'node:http';
import type { Logger } from '@offense-demo/logger';
import { createIngressListener } from './ingress';

/**
 * The production HTTP server start.ts runs: ingress identity stamping
 * through the configured trusted proxies, the app's drain flag, and socket
 * timeouts. Returned unbound; the caller listens.
 */
export function createHttpServer({
  trustedProxies,
  clientIdSubkey,
  isDraining,
  logger,
  handle,
}: {
  /** `AUTH_TRUSTED_PROXIES` from validated auth configuration. */
  readonly trustedProxies: readonly string[];
  /** Derived from the validated `BETTER_AUTH_SECRET` (`deriveClientIdSubkey`). */
  readonly clientIdSubkey: string;
  readonly isDraining: () => boolean;
  readonly logger: Logger;
  readonly handle: Parameters<typeof createIngressListener>[0]['handle'];
}): Server {
  const listen = createIngressListener({
    isDraining,
    trustedProxies,
    clientIdSubkey,
    handle,
    onError: () =>
      logger.log(
        'http.request.failed',
        { operation: 'http.request', errorCode: 'INTERNAL' },
        'Request failed',
      ),
  });
  const server = createServer((request, response) => {
    void listen(request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
