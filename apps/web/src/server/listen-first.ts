import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Clock } from '@offense-demo/clock';
import type { Logger } from '@offense-demo/logger';
import { createProductionServer } from './server-wiring';

type Handle = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<unknown>;

const LIVENESS_PATH = '/api/health/live';

/**
 * The request's path, or null when no URL parser accepts its target (a
 * client may send `//` or `http://[`): such a request is simply not
 * liveness, so the gate answers it 503 instead of throwing out of the
 * request listener.
 */
const requestPath = (target: string | undefined): string | null => {
  try {
    return new URL(target ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
};

const answer = (response: ServerResponse, status: number, body: object) => {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

/**
 * Holds every request off Next until start-up work finishes (ISSUE-172).
 * Until `open()`, liveness answers 200 alive (the same body as the Next
 * route: the process is up) and everything else, readiness included,
 * answers 503 `unavailable` without reaching Next, so fly-proxy routes
 * nothing here before Next is prepared and the runtime role is checked.
 */
function createStartupGate(handle: Handle) {
  let prepared = false;
  return {
    handle: (request: IncomingMessage, response: ServerResponse) => {
      if (prepared) return handle(request, response);
      if (requestPath(request.url) === LIVENESS_PATH)
        answer(response, 200, { status: 'alive' });
      else answer(response, 503, { status: 'unavailable' });
      return Promise.resolve();
    },
    open: () => {
      prepared = true;
    },
  };
}

/**
 * Opens the port first, then runs the slow start-up work and only then
 * opens the gate (ISSUE-172): a cold machine answers its health checks
 * from the moment the process is up instead of refusing connections for
 * the whole of Next's prepare. Logs `server.start` when listening and
 * `server.ready` with the start-up work's duration. A rejected `prepare`
 * rejects here with the gate still shut, so no request ever reaches Next.
 */
async function listenThenPrepare({
  server,
  port,
  host,
  prepare,
  gate,
  logger,
  clock,
}: {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  readonly prepare: () => Promise<void>;
  readonly gate: { readonly open: () => void };
  readonly logger: Logger;
  readonly clock: Clock;
}): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const listeningAt = clock.now();
  logger.log(
    'server.start',
    { operation: 'server.start', port },
    'Server listening',
  );
  await prepare();
  gate.open();
  logger.log(
    'server.ready',
    {
      operation: 'server.ready',
      durationMs: Date.parse(clock.now()) - Date.parse(listeningAt),
    },
    'Server ready',
  );
}

/**
 * The production start-up start.ts runs, whole, so its ordering is tested
 * rather than trusted (ISSUE-193): Next's handler sits behind the start-up
 * gate, the port opens, the ISSUE-39 runtime-role refusal runs, then Next
 * prepares, and only then does the gate open. A refusal rejects `started`
 * before Next is prepared, with every route still answering 503.
 */
export function startProductionServer({
  app,
  nextApp,
  refuseRole,
  readRouteTable,
  port,
  host,
}: {
  readonly app: Parameters<typeof createProductionServer>[0]['app'] & {
    readonly clock: Clock;
  };
  readonly nextApp: {
    readonly getRequestHandler: () => Handle;
    readonly prepare: () => Promise<void>;
  };
  /** Refuses a DATABASE_URL role that can create or alter schema objects. */
  readonly refuseRole: () => Promise<void>;
  readonly readRouteTable: () => string | null;
  readonly port: number;
  readonly host: string;
}): { readonly server: Server; readonly started: Promise<void> } {
  const gate = createStartupGate(nextApp.getRequestHandler());
  const server = createProductionServer({
    app,
    handle: gate.handle,
    readRouteTable,
  });
  const started = listenThenPrepare({
    server,
    port,
    host,
    prepare: async () => {
      await refuseRole();
      await nextApp.prepare();
    },
    gate,
    logger: app.logger,
    clock: app.clock,
  });
  return { server, started };
}
