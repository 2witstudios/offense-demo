/**
 * Local slot administration (ADR 0034): one shared cluster, three databases
 * per checkout slot (dev, integration test, browser e2e).
 * Development tooling only; nothing on the request path imports it.
 *
 * Identifiers and literals in CREATE/DROP/COMMENT/ROLE statements cannot be
 * bound as parameters, so every one is checked against a strict allowlist
 * before it is quoted into SQL.
 */
import type { SQL } from 'bun';
import { quoteIdentifier } from './identifiers';

const passwordPattern = /^[a-z0-9-]{1,64}$/;
const commentPattern = /^[a-z0-9 =-]{1,100}$/;

function quoteLiteral(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
  return `'${value}'`;
}

export type SlotRole = { readonly user: string; readonly password: string };

/**
 * The one place the local and CI test logins are provisioned (ISSUE-6):
 * `bun slot:up`, `bun db:reset` and CI's `bun db:roles` all call it after
 * migrating. The browser suite's loopback-only login is a member of the
 * baseline's `offense_demo_web` runtime role and holds no grant of its own, so it
 * runs the production server with exactly production's privileges, and
 * nothing is lost when a reset drops the schema: membership is cluster-wide
 * and the baseline re-grants `offense_demo_web`. Idempotent and safe to run
 * concurrently with another checkout's call.
 */
export async function provisionTestRoles(
  admin: SQL,
  role: SlotRole,
): Promise<void> {
  const user = quoteIdentifier(role.user);
  const password = quoteLiteral(role.password, passwordPattern, 'password');
  const [existing] =
    await admin`select 1 from pg_roles where rolname = ${role.user}`;
  if (!existing)
    try {
      await admin.unsafe(`create role ${user} login password ${password}`);
    } catch (error) {
      // A concurrent slot:up created it first.
      if ((error as { errno?: string }).errno !== '42710') throw error;
    }
  await admin.unsafe(`grant offense_demo_web to ${user}`);
}

/** Drops every table and the migration log, leaving an empty `public`. */
export async function resetPublicSchema(database: SQL): Promise<void> {
  await database.unsafe(`
    drop schema if exists public cascade;
    drop schema if exists drizzle cascade;
    create schema public;
  `);
}

/**
 * Creates an empty database from `template0`, which accepts no connections,
 * so the copy never fails with "source database is being accessed by other
 * users". Returns false when the database already exists (idempotent).
 */
export async function createSlotDatabase(
  admin: SQL,
  database: string,
): Promise<boolean> {
  const name = quoteIdentifier(database);
  const [existing] =
    await admin`select 1 from pg_database where datname = ${database}`;
  if (existing) return false;
  try {
    await admin.unsafe(`create database ${name} template template0`);
    return true;
  } catch (error) {
    if ((error as { errno?: string }).errno === '42P04') return false;
    throw error;
  }
}

export type SlotDatabase = {
  readonly name: string;
  readonly comment: string | null;
};

export async function listSlotDatabases(
  admin: SQL,
  prefix: string,
): Promise<readonly SlotDatabase[]> {
  const rows = await admin`
    select datname as name, shobj_description(oid, 'pg_database') as comment
    from pg_database
    where starts_with(datname, ${prefix})
    order by datname
  `;
  return rows as SlotDatabase[];
}

export async function setSlotDatabaseComment(
  admin: SQL,
  database: string,
  comment: string,
): Promise<void> {
  const name = quoteIdentifier(database);
  const literal = quoteLiteral(comment, commentPattern, 'comment');
  await admin.unsafe(`comment on database ${name} is ${literal}`);
}

/** Drops even while a forgotten dev server still holds connections. */
export async function dropSlotDatabase(
  admin: SQL,
  database: string,
): Promise<void> {
  const name = quoteIdentifier(database);
  await admin.unsafe(`drop database if exists ${name} with (force)`);
}

/**
 * Serializes slot administration across checkouts (prune, create, port
 * claims) with a cluster-wide session advisory lock. `admin` must be a
 * single-connection client (`max: 1`) so the lock and the work share one
 * session; a dropped connection releases the lock.
 */
export async function withSlotLock<T>(
  admin: SQL,
  work: () => Promise<T>,
): Promise<T> {
  await admin`select pg_advisory_lock(hashtext('offense-demo-slot-admin'))`;
  try {
    return await work();
  } finally {
    await admin`select pg_advisory_unlock(hashtext('offense-demo-slot-admin'))`;
  }
}
