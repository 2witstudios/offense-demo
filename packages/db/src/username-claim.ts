import { and, eq, isNull, sql } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { users } from './schema/users';
import { instrumented, type DatabaseEventSink } from './instrumented';
import { isUniqueViolation } from './unique-violation';

export type UsernameClaim = {
  readonly kind:
    'claimed' | 'unchanged' | 'taken' | 'already-set' | 'unknown-user';
};

/**
 * Server-owned onboarding: sets the username of a user that has none.
 * Uniqueness is the case-insensitive unique index, so concurrent claims of
 * one name produce exactly one winner and every loser changes nothing
 * (`taken`). A retry by the owner reports `unchanged`; a user who already
 * holds a different name reports `already-set`. A product that needs more
 * rows created at onboarding inserts them in this same transaction.
 */
export async function claimUsername(
  database: BunSQLDatabase,
  input: { readonly userId: string; readonly username: string },
  eventSink: DatabaseEventSink | undefined,
): Promise<UsernameClaim> {
  return instrumented(eventSink, 'claimUsername', async () => {
    try {
      return await database.transaction(async (tx) => {
        const claimed = await tx
          .update(users)
          .set({
            username: input.username,
            name: input.username,
            updatedAt: sql`now()`,
            version: sql`${users.version} + 1`,
          })
          .where(and(eq(users.id, input.userId), isNull(users.username)))
          .returning({ id: users.id });
        if (claimed.length > 0) return { kind: 'claimed' } as const;
        const [current] = await tx
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1);
        if (!current) return { kind: 'unknown-user' } as const;
        return current.username?.toLowerCase() === input.username.toLowerCase()
          ? ({ kind: 'unchanged' } as const)
          : ({ kind: 'already-set' } as const);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'taken' } as const;
      throw error;
    }
  });
}
