import { eq } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import type { ResourceKind } from '@offense-demo/protocol';
import { users } from '../schema/users';
import { instrumented, type DatabaseEventSink } from '../instrumented';

/**
 * What a request asks about, by reference. `projects` is a collection with
 * no row to load; a kind naming one row adds its id here and its lookup
 * below, selecting only the columns its rules read.
 */
export type ResourceRef = { readonly kind: ResourceKind };

/**
 * The rows and facts an authorization decision reads (ADR 0048 section 5),
 * as a plain structure: no `@offense-demo/auth` type, so `@offense-demo/auth`'s
 * `toAuthorizationInput` maps it. `resource` is null when the reference
 * names nothing that exists.
 */
export type AuthorizationProjection = {
  readonly resource: { readonly kind: ResourceKind } | null;
  /** The principal's user row is tombstoned, or missing (fail closed). */
  readonly accountErased: boolean;
};

/**
 * Loads the facts for one decision, fresh, with no cross-request cache.
 * `userId` is the signed-in principal's, or null for an anonymous one. It
 * reads only `users.id` and `users.deleted_at`, which the web runtime role
 * may read. Client-supplied flags never enter: the resource comes from the
 * reference's kind (and, for row kinds, rows loaded by id) alone.
 */
export async function loadAuthorizationContext(
  database: BunSQLDatabase,
  input: { readonly userId: string | null; readonly resourceRef: ResourceRef },
  eventSink?: DatabaseEventSink,
): Promise<AuthorizationProjection> {
  const resource = { kind: input.resourceRef.kind };
  const { userId } = input;
  if (userId === null) return { resource, accountErased: false };
  return instrumented(eventSink, 'loadAuthorizationContext', async () => {
    const [row] = await database
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return {
      resource,
      accountErased: row === undefined || row.deletedAt !== null,
    };
  });
}
