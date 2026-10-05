/**
 * One database per integration run (ADR 0034, ISSUE-238). The runner makes a
 * database of the run's own, migrates it, points the suites at it and drops
 * it afterwards, so no row a suite writes can outlive the run that wrote it.
 * A run that is killed cannot drop its database, so the next run drops it:
 * liveness is a session advisory lock the runner holds for as long as it
 * lives, released by Postgres the instant its connection dies, however it
 * died. Development and CI tooling only; nothing on the request path imports
 * it.
 */
import type { SQL } from 'bun';
import { quoteIdentifier } from './identifiers';

const tokenPattern = /^[0-9a-f]{8}$/;
const runSuffix = /^(.*_test)_run_[0-9a-f]{8}$/;

/** A run's token: eight lowercase hex digits of four CSPRNG bytes the caller supplies. */
export function testRunToken(bytes: Uint8Array): string {
  if (bytes.length !== 4) throw new Error('A run token needs four bytes');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** `<slot test database>_run_<token>`. */
export function testRunDatabaseName(
  slotTestDatabase: string,
  token: string,
): string {
  if (!slotTestDatabase.endsWith('_test') || runSuffix.test(slotTestDatabase))
    throw new Error(
      `A run database extends a slot _test database, got "${slotTestDatabase.replace(/_test$/, '')}"`,
    );
  if (!tokenPattern.test(token))
    throw new Error('A run token is eight lowercase hex digits');
  return `${slotTestDatabase}_run_${token}`;
}

/** The slot test database a run database belongs to, or undefined for any other name. */
export const slotDatabaseOfRun = (name: string): string | undefined =>
  runSuffix.exec(name)?.[1];

const lockKey = (name: string) => `hashtextextended('${name}', 0)`;

/**
 * Creates the run's database from `template0` while holding its liveness
 * lock. The lock is taken first, so a concurrent sweep never sees the
 * database without it. `admin` must be a single-connection client (`max: 1`)
 * that stays open for the whole run: closing it, or dying, releases the lock.
 */
export async function claimTestRunDatabase(
  admin: SQL,
  name: string,
): Promise<number> {
  const quoted = quoteIdentifier(name);
  const [{ free }] = (await admin.unsafe(
    `select pg_try_advisory_lock(${lockKey(name)}) as free`,
  )) as [{ free: boolean }];
  if (!free) throw new Error(`Run database ${name} is already claimed`);
  await admin.unsafe(`create database ${quoted} template template0`);
  return backendPid(admin);
}

const backendPid = async (admin: SQL): Promise<number> => {
  const [{ pid }] = (await admin.unsafe('select pg_backend_pid() as pid')) as [
    { pid: number },
  ];
  return pid;
};

/**
 * Whether the liveness lock is gone: it belongs to the backend that claimed
 * the database (`claimedBy`, from `claimTestRunDatabase`), and a connection
 * that Postgres cut and Bun silently re-established is a different backend
 * holding no lock. The runner checks this while the suites run and stops the
 * run when it is true (ISSUE-250).
 */
export async function testRunLockLost(
  admin: SQL,
  claimedBy: number,
): Promise<boolean> {
  try {
    return (await backendPid(admin)) !== claimedBy;
  } catch {
    // The first query on a connection Postgres just terminated fails before
    // Bun reconnects: the same loss, seen a moment earlier.
    return true;
  }
}

/** Drops the run's database even while a forgotten connection holds it. */
export async function dropTestRunDatabase(
  admin: SQL,
  name: string,
): Promise<void> {
  await admin.unsafe(
    `drop database if exists ${quoteIdentifier(name)} with (force)`,
  );
}

async function runDatabasesOf(admin: SQL, slotTestDatabase: string) {
  const rows = (await admin`
    select datname as name from pg_database
    where starts_with(datname, ${`${slotTestDatabase}_run_`})
    order by datname`) as Array<{ name: string }>;
  return rows
    .map(({ name }) => name)
    .filter((name) => slotDatabaseOfRun(name) === slotTestDatabase);
}

/**
 * How many sessions other than ours use the database, and how many of those
 * started within the run bound (ISSUE-260): a session older than the longest a
 * run may last cannot belong to a live run.
 */
async function sessionsOn(admin: SQL, name: string, maxRunMs: number) {
  const [row] = (await admin.unsafe(
    `select count(*)::int as sessions,
       (count(*) filter (where backend_start >= now() - ${Number(maxRunMs)} * interval '1 millisecond'))::int as young
     from pg_stat_activity where datname = '${quoteIdentifier(name).slice(1, -1)}' and pid <> pg_backend_pid()`,
  )) as [{ sessions: number; young: number }];
  return row ?? { sessions: 0, young: 0 };
}

/**
 * Drops every run database of this slot whose runner is gone: the ones whose
 * liveness lock is free and that no session younger than `maxRunMs` uses. A
 * live run holds its lock, and a run that lost it (ISSUE-250) still has its
 * young suite sessions, so a sweep in another process, or another workspace's
 * run in the same slot, never touches it; an orphan that hangs past the bound
 * has its sessions terminated and its database dropped (ISSUE-260).
 * Returns the names dropped.
 */
export async function sweepTestRunDatabases(
  admin: SQL,
  slotTestDatabase: string,
  { maxRunMs }: { readonly maxRunMs: number },
): Promise<readonly string[]> {
  const dropped: string[] = [];
  for (const name of await runDatabasesOf(admin, slotTestDatabase)) {
    const key = lockKey(quoteIdentifier(name).slice(1, -1));
    const [{ free }] = (await admin.unsafe(
      `select pg_try_advisory_lock(${key}) as free`,
    )) as [{ free: boolean }];
    if (!free) continue;
    try {
      // A free lock with a session started within the run bound is a live
      // run whose runner's connection was cut (ISSUE-250): never drop under
      // a suite. Sessions all older than the bound are a hung orphan's
      // (ISSUE-260); the forced drop below ends them.
      if ((await sessionsOn(admin, name, maxRunMs)).young > 0) continue;
      await dropTestRunDatabase(admin, name);
      dropped.push(name);
    } finally {
      await admin.unsafe(`select pg_advisory_unlock(${key})`);
    }
  }
  return dropped;
}

/** slot:down's release: every run database of the slot, live or not. */
export async function dropAllTestRunDatabases(
  admin: SQL,
  slotTestDatabase: string,
): Promise<readonly string[]> {
  const names = await runDatabasesOf(admin, slotTestDatabase);
  for (const name of names) await dropTestRunDatabase(admin, name);
  return names;
}
