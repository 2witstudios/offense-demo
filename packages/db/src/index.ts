import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { sql } from 'drizzle-orm';
import {
  probeListen,
  subscribeOutbox,
  type OutboxListenHandlers,
} from './listen';
import { claimUsername } from './username-claim';
import { authOperations } from './auth-operations';
import { emailDeliveryOperations } from './email-delivery-operations';
import { outboxOperations } from './outbox';
import { instrumented, type DatabaseEventSink } from './instrumented';
import {
  runtimeRoleFactsFrom,
  runtimeRoleFactsQuery,
  runtimeRoleProblems,
  type RuntimeRoleFactsRow,
} from './runtime-role';
import { RUNTIME_SESSION } from './session-bounds';
export type { UsernameClaim } from './username-claim';
export type { DatabaseEventSink } from './instrumented';
export {
  encodeOutboxCursor,
  decodeOutboxCursor,
  OUTBOX_ORIGIN,
  type OutboxAppendInput,
  type OutboxPosition,
  type OutboxRow,
} from './outbox';
export { refuseSchemaAlteringRole } from './runtime-role';

/** Connections in one process's pool unless a caller asks for another size. */
export const DEFAULT_MAX_CONNECTIONS = 10;

/**
 * Composes the auth, email and outbox areas over one connection pool
 * (ISSUE-8 AC1): every area receives only the opaque Drizzle handle and the
 * event sink, never the raw client, and returns records, not rows.
 * `transaction`, `createUser` and the raw `outbox` table have no production
 * consumer (review T5) and are deliberately absent from this surface — `packages/db`'s own tests reach them through
 * `test-only-operations.ts` and direct submodule imports instead.
 */
export function createDatabase({
  url,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  eventSink,
  client: injectedClient,
}: {
  url: string;
  maxConnections?: number;
  eventSink?: DatabaseEventSink;
  /** Overrides dialing `url`; tests inject a scripted client at this seam. */
  client?: SQL;
}) {
  const client =
    injectedClient ??
    new SQL(url, {
      max: maxConnections,
      connectionTimeout: 3,
      idleTimeout: 20,
      connection: RUNTIME_SESSION,
    });
  const database = drizzle({ client });
  return {
    async health() {
      return instrumented(eventSink, 'health', async () => {
        await database.execute(sql`select 1`);
        return true;
      });
    },
    /**
     * The database this connection actually landed on, from the server
     * itself (`current_database()`), never parsed back out of `url`. A
     * connection URL's database name can be overridden by a `?database=`
     * query parameter Bun's `SQL` client honors (standard libpq connection-
     * string behavior), so a caller that must confirm which database it
     * is about to act on — a destructive script guarding against the wrong
     * target — checks this, not the URL string.
     */
    async currentDatabaseName(): Promise<string> {
      return instrumented(eventSink, 'currentDatabaseName', async () => {
        const [row] = (await database.execute(
          sql`select current_database() as name`,
        )) as unknown as Array<{ name: string }>;
        return row!.name;
      });
    },
    async checkListen() {
      return instrumented(eventSink, 'checkListen', async () => {
        await probeListen(client);
        return true;
      });
    },
    /**
     * How the connected role could create or alter schema objects in
     * `public` (ISSUE-39); empty for the DML-only runtime role. Production
     * startup refuses to serve unless it is empty.
     */
    async runtimeRoleProblems() {
      return instrumented(eventSink, 'runtimeRoleProblems', async () => {
        const [row] = (await database.execute(
          runtimeRoleFactsQuery,
        )) as unknown as RuntimeRoleFactsRow[];
        // No row means no schema public: nothing proves the role is safe.
        if (row === undefined) throw new Error('Schema public is missing');
        return runtimeRoleProblems(runtimeRoleFactsFrom(row));
      });
    },
    /**
     * The RT-2.3b drain loop's LISTEN subscription (ADR 0032 §2, §3): the
     * raw client only `createDatabase` holds, never handed out as the
     * opaque Drizzle handle other operations receive.
     */
    listenOutbox(handlers: OutboxListenHandlers) {
      return subscribeOutbox(client, handlers);
    },
    async close() {
      await client.close({ timeout: 5 });
    },
    ...authOperations({ database, eventSink }),
    ...emailDeliveryOperations({ database, eventSink }),
    ...outboxOperations({ database, eventSink }),
    /** Server-owned onboarding claim; see `claimUsername`. */
    claimUsername: (input: { userId: string; username: string }) =>
      claimUsername(database, input, eventSink),
  };
}
export type Database = ReturnType<typeof createDatabase>;
