import type { Logger } from '@offense-demo/logger';
import { APIError } from 'better-auth/api';
import { createAppError } from '@offense-demo/errors';
import { z } from 'zod';
import { logAuthLifecycle } from '../auth/lifecycle-events';
import {
  handleOperation,
  parseValidated,
  readJson,
  requireSameOrigin,
  requireSameOriginRead,
} from '../../server/http';

/** Better Auth's stored session row, as `listSessions`/`getSession` return it. */
type BetterAuthSessionRow = {
  readonly id: string;
  readonly token: string;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
  readonly expiresAt: string | Date;
  readonly userAgent?: string | null | undefined;
};

/**
 * The browser-safe shape: never the bearer-capable token or the client IP
 * address, which stays on the server (ISSUE-5 AC7).
 */
export type SessionDto = {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly userAgent: string | null;
  readonly current: boolean;
};

const iso = (value: string | Date) =>
  typeof value === 'string' ? value : value.toISOString();

const toDto = (
  row: BetterAuthSessionRow,
  currentSessionId: string | null,
): SessionDto => ({
  id: row.id,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  expiresAt: iso(row.expiresAt),
  userAgent: row.userAgent ?? null,
  current: row.id === currentSessionId,
});

/** Same mapping `security-client.ts`'s `outcomeFor` reads on the client. */
const mapBetterAuthError = (error: unknown) => {
  if (
    error instanceof APIError &&
    (error.statusCode === 401 || error.statusCode === 403)
  )
    return createAppError('AUTHENTICATION', undefined, error);
  return createAppError('INFRASTRUCTURE', undefined, error);
};

type SessionsDependencies = {
  readonly logger: Logger;
  readonly origin: () => string;
  readonly listSessions: (
    headers: Headers,
  ) => Promise<readonly BetterAuthSessionRow[]>;
  readonly currentSessionId: (headers: Headers) => Promise<string | null>;
};

/**
 * GET /api/account/sessions: every field except the bearer-capable session
 * token, which never needs to leave the server (AC7). `current` is computed
 * here from the caller's own session, not the client comparing tokens.
 */
export function createListSessionsHandler(dependencies: SessionsDependencies) {
  return (request: Request) =>
    handleOperation(
      dependencies.logger,
      request,
      'account.sessions.list',
      async () => {
        requireSameOriginRead(request, dependencies.origin());
        let rows: readonly BetterAuthSessionRow[];
        let currentSessionId: string | null;
        try {
          [rows, currentSessionId] = await Promise.all([
            dependencies.listSessions(request.headers),
            dependencies.currentSessionId(request.headers),
          ]);
        } catch (error) {
          throw mapBetterAuthError(error);
        }
        return Response.json({
          sessions: rows.map((row) => toDto(row, currentSessionId)),
        });
      },
    );
}

const revokeBody = z.strictObject({ id: z.string().min(1) });

type RevokeSessionDependencies = {
  readonly logger: Logger;
  readonly origin: () => string;
  readonly listSessions: (
    headers: Headers,
  ) => Promise<readonly BetterAuthSessionRow[]>;
  readonly revokeToken: (headers: Headers, token: string) => Promise<void>;
};

/**
 * POST /api/account/sessions/revoke: revokes by session id. The id is
 * resolved to its token server-side (`listSessions`, already scoped to the
 * caller's own sessions) — the token itself never reaches or leaves the
 * browser (AC7).
 */
export function createRevokeSessionHandler(
  dependencies: RevokeSessionDependencies,
) {
  return (request: Request) =>
    handleOperation(
      dependencies.logger,
      request,
      'account.sessions.revoke',
      async (_id, logger) => {
        requireSameOrigin(request, dependencies.origin());
        const { id } = parseValidated(revokeBody, await readJson(request));
        let rows: readonly BetterAuthSessionRow[];
        try {
          rows = await dependencies.listSessions(request.headers);
        } catch (error) {
          throw mapBetterAuthError(error);
        }
        const target = rows.find((row) => row.id === id);
        if (!target) throw createAppError('NOT_FOUND');
        try {
          await dependencies.revokeToken(request.headers, target.token);
        } catch (error) {
          throw mapBetterAuthError(error);
        }
        logAuthLifecycle(logger, '/revoke-session');
        return Response.json({ status: true });
      },
    );
}
