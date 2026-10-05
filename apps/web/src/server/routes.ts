import {
  createListSessionsHandler,
  createRevokeSessionHandler,
} from '../features/account/sessions';
import { createUsernameHandler } from '../features/account/username';
import { createConfirmEmailHandlers } from '../features/auth/confirm-email';
import { createConfirmHandlers } from '../features/auth/confirm';
import { createAuthRouteHandlers } from '../features/auth/handlers';
import { createAlertsHandler } from '../features/ops/alerts';
import { createMetricsHandler } from '../features/ops/metrics';
import { createTicketHandler } from '../features/realtime/ticket';
import { identify } from '../lib/identity';
import type { App } from './app';
import { handleOperation } from './http';
import { createReadinessHandler } from './readiness';

/**
 * Every route handler, built from one app. The Next route modules under
 * `app/` only bind these to their paths (`process-app.ts`); tests call the
 * same handlers on an app they built themselves.
 */
export function createRoutes(app: App) {
  const { logger, database } = app;
  const origin = () => app.auth().config.PUBLIC_APP_URL;
  const confirmAuth = () => {
    const { instance, config } = app.auth();
    return { handler: instance.handler, config };
  };
  return {
    auth: createAuthRouteHandlers(confirmAuth, logger),
    confirm: createConfirmHandlers({ auth: confirmAuth, logger }),
    confirmEmail: createConfirmEmailHandlers({ auth: confirmAuth, logger }),
    sessions: {
      GET: createListSessionsHandler({
        logger,
        origin,
        listSessions: async (headers) =>
          app.auth().instance.api.listSessions({ headers }),
        currentSessionId: async (headers) => {
          const found = await app.auth().instance.api.getSession({
            headers,
            query: { disableRefresh: true },
          });
          return found?.session.id ?? null;
        },
      }),
    },
    revokeSession: {
      POST: createRevokeSessionHandler({
        logger,
        origin,
        listSessions: async (headers) =>
          app.auth().instance.api.listSessions({ headers }),
        revokeToken: async (headers, token) => {
          await app
            .auth()
            .instance.api.revokeSession({ headers, body: { token } });
        },
      }),
    },
    username: {
      POST: createUsernameHandler({
        logger,
        origin,
        identify: (request) => identify(app.auth(), request.headers),
        limiter: () => app.auth().limiter,
        claim: (input) => database.claimUsername(input),
      }),
    },
    ticket: {
      POST: createTicketHandler({
        logger,
        origin,
        identify: (request) => identify(app.auth(), request.headers),
        sessionId: async (headers) => {
          const found = await app.auth().instance.api.getSession({
            headers,
            query: { disableRefresh: true },
          });
          return found?.session.id ?? null;
        },
        limiter: () => app.auth().limiter,
        issueTicket: (input) =>
          app.redis.issueConnectTicket(
            input.ticketHash,
            {
              userId: input.userId,
              sessionId: input.sessionId,
              origin: input.origin,
            },
            input.ttlSeconds,
          ),
      }),
    },
    /** Provider-signed, server-to-server: authenticity replaces the origin check. */
    mailWebhook: {
      POST: (request: Request) =>
        handleOperation(logger, request, 'auth.mail.webhook', () =>
          app.mailWebhook().handle(request),
        ),
    },
    ready: {
      GET: createReadinessHandler({
        database,
        redis: app.redis,
        isDraining: app.isDraining,
        logger,
      }),
    },
    ops: {
      alerts: {
        GET: createAlertsHandler({
          logger,
          redis: app.redis,
          local: app.localAlertState,
          clock: app.clock,
          token: () => app.opsProbeToken(),
        }),
      },
      metrics: {
        GET: createMetricsHandler({
          logger,
          metrics: app.metrics,
          token: () => app.opsProbeToken(),
        }),
      },
    },
  };
}

export type Routes = ReturnType<typeof createRoutes>;
