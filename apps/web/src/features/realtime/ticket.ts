import { createHash } from 'node:crypto';
import type { Identity } from '@offense-demo/auth';
import { createAppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import { ticketSchema } from '@offense-demo/protocol';
import { consumeOrThrow, type AuthRateLimiter } from '../auth/rate-limit';
import {
  handleOperation,
  requireSameOrigin,
  requireSignedIn,
} from '../../server/http';

/** ADR 0031 §11 / plan section D: 60 s, single-use. */
const TICKET_TTL_SECONDS = 60;
/**
 * Enough for a tab reconnecting through a flaky network to keep getting
 * fresh tickets, far below what a ticket-mining abuse pattern would need.
 */
const TICKET_RULE = { windowSeconds: 60, max: 20 } as const;

type TicketDependencies = {
  readonly logger: Logger;
  readonly origin: () => string;
  /** Principal resolution from the request's cookies only. */
  readonly identify: (request: Request) => Promise<Identity>;
  /** The caller's own durable session id, resolved from the same cookies. */
  readonly sessionId: (headers: Headers) => Promise<string | null>;
  readonly limiter: () => AuthRateLimiter;
  readonly issueTicket: (input: {
    readonly ticketHash: string;
    readonly userId: string;
    readonly sessionId: string;
    readonly origin: string;
    readonly ttlSeconds: number;
  }) => Promise<void>;
};

/**
 * 32 CSPRNG bytes, base64url-encoded: 43 characters, never a cuid2 (ADR
 * 0031 §11). Validated against the protocol's own `hello.ticket` shape so a
 * future change to either side turns this red rather than silently
 * diverging (the plan: "the protocol's hello schema ... reuse it").
 */
function randomTicket(): string {
  const ticket = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString('base64url');
  if (!ticketSchema.safeParse(ticket).success) throw createAppError('INTERNAL');
  return ticket;
}

const hashTicket = (ticket: string): string =>
  createHash('sha3-256').update(ticket).digest('hex');

/**
 * POST /api/realtime/ticket: the only way a browser obtains a realtime
 * connect ticket (ADR 0031 §11, plan section D). Gate order is ADR 0020:
 * route (same origin), Principal (session cookie), authorization (a
 * signed-in member), atomic rate limit, and only then the durable write.
 */
export function createTicketHandler(dependencies: TicketDependencies) {
  return (request: Request) =>
    handleOperation(
      dependencies.logger,
      request,
      'realtime.ticket.issue',
      async () => {
        requireSameOrigin(request, dependencies.origin());
        const identity = requireSignedIn(await dependencies.identify(request));
        // Signed in, but has not finished onboarding (no username yet):
        // authenticated, not authorized, as authorizeRequest answers it.
        if (identity.state === 'provisional')
          throw createAppError('AUTHORIZATION');
        const { userId } = identity.principal;
        await consumeOrThrow(
          dependencies.limiter(),
          `realtime:ticket:${userId}`,
          TICKET_RULE,
        );
        const sessionId = await dependencies.sessionId(request.headers);
        // The session read that produced `identity` just succeeded; a null
        // here means it lapsed in the instant between the two reads.
        if (!sessionId) throw createAppError('AUTHENTICATION');
        const ticket = randomTicket();
        const origin = new URL(dependencies.origin()).origin;
        await dependencies.issueTicket({
          ticketHash: hashTicket(ticket),
          userId,
          sessionId,
          origin,
          ttlSeconds: TICKET_TTL_SECONDS,
        });
        return Response.json({
          ticket,
          expiresInSeconds: TICKET_TTL_SECONDS,
        });
      },
    );
}
