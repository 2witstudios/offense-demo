import type { IncomingMessage, ServerResponse } from 'node:http';
import { stampClientIdentity } from '../features/auth/client-ip';

type IngressDeps = {
  readonly isDraining: () => boolean;
  readonly trustedProxies: readonly string[];
  /** Keys the client id hash request logs carry (`deriveClientIdSubkey`). */
  readonly clientIdSubkey: string;
  readonly handle: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<unknown>;
  readonly onError: () => void;
};

/** Request-listener wiring: drain 503, identity stamping, Next handoff. */
export function createIngressListener(deps: IngressDeps) {
  return (request: IncomingMessage, response: ServerResponse) => {
    if (deps.isDraining()) {
      response.writeHead(503);
      response.end();
      return Promise.resolve();
    }
    // Ingress boundary: the socket peer (or a configured trusted proxy chain)
    // establishes client identity; any caller-supplied identity header is replaced.
    stampClientIdentity(request, deps.trustedProxies, deps.clientIdSubkey);
    return deps.handle(request, response).catch(() => {
      deps.onError();
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  };
}
