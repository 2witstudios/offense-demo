import type { Server } from 'node:http';
import type { AuthConfig } from '@offense-demo/config';
import type { Logger } from '@offense-demo/logger';
import { deriveClientIdSubkey } from '../features/auth/client-ip';
import { createHttpServer } from './http-server';
import { defaultGateway, resolveTrustedProxies } from './trusted-proxies';

/**
 * The production server start.ts runs, composed from the app this process
 * built, isolated from start.ts's top-level side effects so a test can prove
 * the wiring on a real socket: ingress stamping through the validated
 * `AUTH_TRUSTED_PROXIES`, a client id keyed by `BETTER_AUTH_SECRET`, and the
 * app's own drain flag (AUTH-3.8, ISSUE-158). Reading the auth configuration
 * here, eagerly, is what refuses a production start without auth secrets
 * before Next prepares or the port opens; its errors name fields only
 * (AUTH-7.0-AC3).
 *
 * The `gateway` keyword in `AUTH_TRUSTED_PROXIES` becomes this machine's one
 * default gateway from `readRouteTable` (fly-proxy's address on Fly,
 * ISSUE-162). Unreadable or ambiguous, it trusts nothing for that entry —
 * every caller then shares the gateway's identity — and logs
 * `ingress.trusted_proxy.unresolved`.
 */
export function createProductionServer({
  app,
  handle,
  readRouteTable,
}: {
  readonly app: {
    readonly auth: () => {
      readonly config: Pick<
        AuthConfig,
        'AUTH_TRUSTED_PROXIES' | 'BETTER_AUTH_SECRET'
      >;
    };
    readonly isDraining: () => boolean;
    readonly logger: Logger;
  };
  readonly handle: Parameters<typeof createHttpServer>[0]['handle'];
  /** `/proc/net/route`'s text, or null when it cannot be read. */
  readonly readRouteTable: () => string | null;
}): Server {
  const authConfig = app.auth().config;
  const routeTable =
    authConfig.AUTH_TRUSTED_PROXIES.length > 0 ? readRouteTable() : null;
  const { trustedProxies, gatewayUnresolved } = resolveTrustedProxies(
    authConfig.AUTH_TRUSTED_PROXIES,
    routeTable === null ? null : defaultGateway(routeTable),
  );
  if (gatewayUnresolved)
    app.logger.log(
      'ingress.trusted_proxy.unresolved',
      { operation: 'server.start' },
      'No single default gateway was found, so no proxy is trusted for it',
    );
  return createHttpServer({
    trustedProxies,
    clientIdSubkey: deriveClientIdSubkey(authConfig.BETTER_AUTH_SECRET),
    isDraining: app.isDraining,
    logger: app.logger,
    handle,
  });
}
