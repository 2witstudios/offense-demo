import type { BetterAuthPlugin } from 'better-auth';
import {
  createAuthEndpoint,
  sensitiveSessionMiddleware,
} from 'better-auth/api';

/** `@offense-demo/db`'s `revokeOtherSessions`: every session but `keepToken` (all when null). */
export type RevokeSessions = (
  userId: string,
  keepToken: string | null,
) => Promise<number>;

/**
 * ISSUE-22 (owner decision, 2026-09-23): every revoke-all is serialized in
 * the database against session creation for the user, and the one
 * operation that does it is `@offense-demo/db`'s `revokeOtherSessions` (a user-row
 * lock, then one DELETE, with the `session.revoked` append in the same
 * transaction). Better Auth 1.7.5's `/revoke-other-sessions` lists the
 * sessions and deletes them one by one, and its `/revoke-sessions` deletes
 * without the lock, so a session committed while either runs can survive.
 * These endpoints replace both under the same keys and paths (plugin
 * endpoints are spread over the core set), so the fresh-session gate, rate
 * limit and lifecycle events keyed on those paths still apply, and the
 * response is Better Auth's own `{ status: true }`.
 */
export const revokeSessionsPlugin = (
  revokeSessions: RevokeSessions,
): BetterAuthPlugin => ({
  id: 'offense-demo-revoke-sessions',
  endpoints: {
    revokeOtherSessions: createAuthEndpoint(
      '/revoke-other-sessions',
      {
        method: 'POST',
        requireHeaders: true,
        use: [sensitiveSessionMiddleware],
      },
      async (ctx) => {
        const { session } = ctx.context.session;
        await revokeSessions(session.userId, session.token);
        return ctx.json({ status: true });
      },
    ),
    revokeSessions: createAuthEndpoint(
      '/revoke-sessions',
      {
        method: 'POST',
        requireHeaders: true,
        use: [sensitiveSessionMiddleware],
      },
      async (ctx) => {
        await revokeSessions(ctx.context.session.session.userId, null);
        return ctx.json({ status: true });
      },
    ),
  },
});
