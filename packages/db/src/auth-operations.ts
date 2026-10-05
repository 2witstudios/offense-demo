import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { and, eq, ne, notExists, sql } from 'drizzle-orm';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { accounts, passkeys, sessions, verifications } from './schema/auth';
import { users } from './schema/users';
import { instrumented, type DatabaseEventSink } from './instrumented';
import { appendSessionRevokedFor } from './session-revoked';
import { deleteExpiredBatch, type RetentionBatch } from './retention';
import { isUniqueViolation } from './sql-state';

/** What an email-change completion did; `stale` changed nothing. */
export type EmailChangeCompletion = 'changed' | 'stale';

/**
 * The auth area (ISSUE-8 AC1): Better Auth's own adapter plus Offense Demo's
 * email-change completion and three session-revocation operations. Drizzle
 * stays inside this module; callers receive the adapter as an opaque
 * capability, never a table or a transaction handle.
 */
export const authOperations = ({
  database,
  eventSink,
}: {
  readonly database: BunSQLDatabase;
  readonly eventSink?: DatabaseEventSink | undefined;
}) => {
  const authAdapter = drizzleAdapter(database, {
    provider: 'pg',
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
      passkey: passkeys,
    },
  });
  return {
    authAdapter,
    /**
     * RT-2.2 (plan revision 4.1, ADR 0032 §5): appends one `session.revoked`
     * outbox row in its own short transaction, for a caller that has already
     * confirmed a session delete outside Offense Demo's control (Better Auth's own
     * revoke endpoints). Never wraps the delete itself.
     */
    async appendSessionRevoked(userId: string): Promise<void> {
      return instrumented(eventSink, 'appendSessionRevoked', () =>
        database.transaction((tx) => appendSessionRevokedFor(tx, userId)),
      );
    },
    /**
     * ISSUE-99 (AUTH-5.6): the email change's final step, in one
     * transaction. It moves the account from `email` to `newEmail` (marked
     * verified, since the caller just proved the new inbox) and deletes every
     * outstanding emailed sign-in link whose subject is the old address, so a
     * link mailed there before the change can neither sign in to the account
     * nor, once the address is free, sign up a new account there. The links
     * are the rows whose identifier starts with `<signInPurpose>:` (the
     * caller's emailed-link purpose prefix, ADR 0025) and whose JSON value
     * names the old address, compared case-insensitively. `stale`, changing
     * nothing, when the account no longer holds `email` or `newEmail` is
     * taken in the meantime (the unique index decides a race).
     */
    async completeEmailChange(input: {
      readonly userId: string;
      readonly email: string;
      readonly newEmail: string;
      readonly signInPurpose: string;
    }): Promise<EmailChangeCompletion> {
      return instrumented(eventSink, 'completeEmailChange', async () => {
        try {
          return await database.transaction(async (tx) => {
            const moved = await tx
              .update(users)
              .set({
                email: input.newEmail,
                emailVerified: true,
                updatedAt: sql`now()`,
                version: sql`${users.version} + 1`,
              })
              .where(
                and(eq(users.id, input.userId), eq(users.email, input.email)),
              )
              .returning({ id: users.id });
            if (moved.length === 0) return 'stale';
            // CASE, not AND: Postgres may evaluate AND operands in any order,
            // and only rows of this purpose are guaranteed to hold JSON.
            await tx
              .delete(verifications)
              .where(
                sql`case when starts_with(${verifications.identifier}, ${`${input.signInPurpose}:`}) then lower(${verifications.value}::jsonb ->> 'email') = lower(${input.email}) else false end`,
              );
            return 'changed';
          });
        } catch (error) {
          if (isUniqueViolation(error)) return 'stale';
          throw error;
        }
      });
    },
    /**
     * ISSUE-103: deletes the session `token` unless its account still holds
     * `email`, the address the sign-in that just created it proved, and
     * reports whether it did. One statement, run after that session's insert
     * has committed: an email change whose address switch committed first is
     * seen by this statement's snapshot, and one that commits later is
     * followed by its revoke-all, which the insert's user-row lock orders
     * after the insert (ISSUE-22), so either way no session proved by the
     * old address outlives the change. The session has not yet reached its
     * client, so there is nothing to announce: no `session.revoked` append.
     */
    async revokeSessionUnlessAddressHeld(input: {
      readonly token: string;
      readonly email: string;
    }): Promise<boolean> {
      return instrumented(
        eventSink,
        'revokeSessionUnlessAddressHeld',
        async () => {
          const rows = await database
            .delete(sessions)
            .where(
              and(
                eq(sessions.token, input.token),
                notExists(
                  database
                    .select({ id: users.id })
                    .from(users)
                    .where(
                      and(
                        eq(users.id, sessions.userId),
                        eq(users.email, input.email),
                      ),
                    ),
                ),
              ),
            )
            .returning({ id: sessions.id });
          return rows.length > 0;
        },
      );
    },
    /**
     * The one revoke-all (ISSUE-22, owner decision 2026-09-23): revokes
     * every session for `userId` except `keepToken` (every session when it
     * is null), serialized in the database against session creation for
     * that user. It first takes the user row `FOR UPDATE`; every session
     * insert holds `FOR KEY SHARE` on that same row until it commits (the
     * `session.user_id` foreign key check), and the two conflict. So an
     * insert still uncommitted when the revoke starts makes the revoke wait,
     * and the DELETE, a separate statement with its own Read Committed
     * snapshot taken after the lock, then sees and removes that session; an
     * insert that starts after the lock waits for the revoke to commit and
     * lands after it. One statement could not do this: a statement's
     * snapshot predates any lock wait inside it. Better Auth's own revoke
     * endpoints are routed here (`revoke-sessions.ts`), and every future
     * revoke-all (recovery, admin ban) must call it too.
     *
     * Offense Demo's own operation, not one of Better Auth's internal deletes, so
     * the `session.revoked` append happens in the *same* transaction as the
     * DELETE (ADR 0032 §5, plan revision 4.7): a failed append rolls the
     * DELETE back too, rather than being swallowed best-effort. Returns the
     * number of sessions removed.
     */
    async revokeOtherSessions(
      userId: string,
      keepToken: string | null,
    ): Promise<number> {
      return instrumented(eventSink, 'revokeOtherSessions', () =>
        database.transaction(async (tx) => {
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for('update');
          const rows = await tx
            .delete(sessions)
            .where(
              keepToken === null
                ? eq(sessions.userId, userId)
                : and(
                    eq(sessions.userId, userId),
                    ne(sessions.token, keepToken),
                  ),
            )
            .returning({ id: sessions.id });
          if (rows.length > 0) await appendSessionRevokedFor(tx, userId);
          return rows.length;
        }),
      );
    },
    /**
     * Retention (AUTH-7.5): one bounded batch of session rows whose expiry
     * is before the cutoff. `revokeOtherSessions` and
     * `revokeSessionUnlessAddressHeld` already delete a revoked session
     * immediately, so nothing "revoked" is ever left for this sweep to
     * find; it only drains sessions that ran to their own natural expiry
     * and were never signed out of, which is why it needs the same 24-hour
     * grace as verification rows rather than deleting the moment they
     * expire.
     */
    async purgeExpiredSessions(input: RetentionBatch) {
      return instrumented(eventSink, 'purgeExpiredSessions', () =>
        deleteExpiredBatch(
          database,
          { table: sessions, key: sessions.id, at: sessions.expiresAt },
          input,
        ),
      );
    },
    /**
     * AUTH-7.6: the post-restore step. Unconditionally deletes every session
     * and verification row, run once against a freshly restored database
     * before it takes traffic, so a pre-restore session cookie or emailed
     * link can never authenticate against the restored copy. Unlike
     * `revokeOtherSessions` this is total and never scoped to one user — a
     * restore has no live user context to scope to — so it never appends a
     * `session.revoked` outbox row (no realtime instance watches a copy that
     * has not taken traffic yet).
     */
    async purgeAllForRestore(): Promise<{
      readonly sessions: number;
      readonly verifications: number;
    }> {
      return instrumented(eventSink, 'purgeAllForRestore', () =>
        database.transaction(async (tx) => {
          const deletedSessions = await tx
            .delete(sessions)
            .returning({ id: sessions.id });
          const deletedVerifications = await tx
            .delete(verifications)
            .returning({ id: verifications.id });
          return {
            sessions: deletedSessions.length,
            verifications: deletedVerifications.length,
          };
        }),
      );
    },
  };
};
