import { sql, type SQL as DrizzleSql } from 'drizzle-orm';

/**
 * What the connected role could do to the schema (ISSUE-39): read from the
 * catalog for `current_user`. Membership counts as ownership because a
 * member can `set role` to the owner and alter what it owns.
 */
export type RuntimeRoleFacts = {
  readonly superuser: boolean;
  readonly createInPublic: boolean;
  readonly ownsPublicSchema: boolean;
  readonly ownedObjectsInPublic: number;
};

export const runtimeRoleFactsQuery: DrizzleSql = sql`
  select
    r.rolsuper as superuser,
    has_schema_privilege('public', 'CREATE') as create_in_public,
    pg_has_role(n.nspowner, 'MEMBER') as owns_public_schema,
    (
      (select count(*) from pg_class c
        where c.relnamespace = n.oid and pg_has_role(c.relowner, 'MEMBER'))
      + (select count(*) from pg_proc p
        where p.pronamespace = n.oid and pg_has_role(p.proowner, 'MEMBER'))
      + (select count(*) from pg_type t
        where t.typnamespace = n.oid and pg_has_role(t.typowner, 'MEMBER'))
    )::int as owned_objects_in_public
  from pg_namespace n
  join pg_roles r on r.rolname = current_user
  where n.nspname = 'public'
`;

export type RuntimeRoleFactsRow = {
  readonly superuser: boolean;
  readonly create_in_public: boolean;
  readonly owns_public_schema: boolean;
  readonly owned_objects_in_public: number;
};

export const runtimeRoleFactsFrom = (
  row: RuntimeRoleFactsRow,
): RuntimeRoleFacts => ({
  superuser: row.superuser,
  createInPublic: row.create_in_public,
  ownsPublicSchema: row.owns_public_schema,
  ownedObjectsInPublic: Number(row.owned_objects_in_public),
});

/**
 * Every way the runtime role could create or alter schema objects in
 * `public`; empty only for a DML-only role such as `offense_demo_web`. Names
 * capabilities, never the role, the URL or a credential.
 */
export function runtimeRoleProblems(
  facts: RuntimeRoleFacts,
): readonly string[] {
  return [
    facts.superuser ? 'is a superuser' : null,
    facts.createInPublic ? 'can create in schema public' : null,
    facts.ownsPublicSchema ? 'owns schema public' : null,
    facts.ownedObjectsInPublic > 0
      ? `owns ${facts.ownedObjectsInPublic} objects in schema public`
      : null,
  ].filter((problem): problem is string => problem !== null);
}

/**
 * Production serves only as its runtime role (ISSUE-39, ISSUE-101): the web
 * app as `offense_demo_web`, the realtime service as `offense_demo_realtime`; migrations
 * run as the owner from a separate release app (ADR 0041). Reads validated config,
 * so a development server running as the local owner still starts.
 */
export async function refuseSchemaAlteringRole(
  app: {
    readonly config: { readonly NODE_ENV: string };
    readonly database: {
      readonly runtimeRoleProblems: () => Promise<readonly string[]>;
    };
  },
  runtimeRole: 'offense_demo_web' | 'offense_demo_realtime',
): Promise<void> {
  if (app.config.NODE_ENV !== 'production') return;
  const problems = await app.database.runtimeRoleProblems();
  if (problems.length > 0)
    throw new Error(
      `Production refuses a DATABASE_URL role that ${problems.join(', ')}; use the ${runtimeRole} runtime role`,
    );
}
