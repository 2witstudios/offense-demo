import type { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { users } from './schema/users';
import { instrumented, type DatabaseEventSink } from './instrumented';

/**
 * ISSUE-8 AC1: `transaction` and `createUser` have no
 * production consumer (review T5) — nothing in `apps/web` or `apps/realtime`
 * calls them, so `createDatabase()` never returns them. This composes them
 * onto the same client for `packages/db`'s own unit and integration suites;
 * nothing outside this package imports this file.
 */
export function createTestOnlyOperations({
  client,
  eventSink,
}: {
  readonly client: SQL;
  readonly eventSink?: DatabaseEventSink | undefined;
}) {
  const database = drizzle({ client });
  return {
    transaction: database.transaction.bind(database),
    async createUser(input: { id: string; username: string }) {
      return instrumented(eventSink, 'createUser', async () => {
        const [row] = await database.insert(users).values(input).returning();
        if (!row) throw new Error('User insert returned no row');
        return row;
      });
    },
  };
}
