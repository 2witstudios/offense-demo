/**
 * The URL's database name, exactly as `new URL(url).pathname` gives it —
 * the pre-flight check only, cheap and connection-free, but not the ground
 * truth: a `?database=` query parameter on the same URL overrides which
 * database Bun's `SQL` client actually connects to (standard libpq
 * connection-string behavior), so this can name one database while the
 * connection lands on another. `refusalForActualName` below is the
 * authoritative check, run against `current_database()` after connecting;
 * this one exists only to fail fast on an honest mistake before opening a
 * connection at all.
 */
const urlDatabaseName = (databaseUrl: string): string =>
  new URL(databaseUrl).pathname.replace(/^\//, '');

const nameRefusal = (
  name: string,
  marker: string,
  force: boolean,
  context: string,
): string | undefined => {
  if (force || name.toLowerCase().includes(marker)) return undefined;
  return (
    `Refusing: the database "${name}" does not name itself ${marker} ` +
    `(expected "${marker}" in the name). ${context} Pass --force only for ` +
    `a database you have independently confirmed is correct.`
  );
};

/**
 * The pre-flight check `scripts/post-restore-invalidate.ts` runs before
 * opening any connection: a database name that does not name itself a
 * restore copy refuses the command outright, `--force` aside. Pure so it
 * is unit-tested without a database. See `refusalForActualName` for the
 * check that runs after connecting, against the real database.
 */
export function refusalFor(
  databaseUrl: string,
  force: boolean,
): string | undefined {
  return nameRefusal(
    urlDatabaseName(databaseUrl),
    'restore',
    force,
    'This command is destructive to every session and verification row.',
  );
}

/**
 * The pre-flight check `scripts/staging-restore-seed.ts` runs before
 * opening any connection: a database name that does not name itself
 * staging refuses the command outright, `--force` aside. This script
 * writes synthetic users, actors, sessions, passkeys and a
 * verification token — real writes, so a `DATABASE_URL` pointed at
 * production by mistake must never reach `applyDevSeed`'s first insert.
 * See `refusalForActualName` for the check that runs after connecting,
 * against the real database.
 */
export function refusalForStagingSeed(
  databaseUrl: string,
  force: boolean,
): string | undefined {
  return nameRefusal(
    urlDatabaseName(databaseUrl),
    'staging',
    force,
    'This script writes synthetic auth rows.',
  );
}

/**
 * The authoritative check: `actualName` must come from
 * `Database.currentDatabaseName()` (`current_database()`, queried on the
 * live connection), never from the URL string, so a `?database=` query
 * parameter or any other way a connection string can land somewhere other
 * than its own path can never slip past `refusalFor`/`refusalForStagingSeed`
 * — those two catch an honest mistake before a connection even opens; this
 * one is what actually gates the destructive operation that follows it.
 */
export function refusalForActualName(
  actualName: string,
  marker: string,
  force: boolean,
): string | undefined {
  return nameRefusal(
    actualName,
    marker,
    force,
    'The database this connection actually landed on does not match what its URL claimed.',
  );
}

/**
 * `clearAuthRateLimits` acts on whatever `REDIS_NAMESPACE` names, entirely
 * independent of the database-name check above: a real restore's namespace
 * need not contain "restore" at all (a blue/green restore can reuse the
 * live app's own namespace on purpose), so this deliberately does not reuse
 * `refusalFor`'s name-pattern heuristic. Instead it
 * requires the operator to retype the exact namespace as an explicit,
 * separate confirmation — a deliberate act, not an inferred one — so a
 * `REDIS_NAMESPACE` left over from a different, live command never gets
 * its rate-limit counters cleared by accident.
 *
 * Confirming the namespace alone still leaves a gap: a
 * confirmed namespace says nothing about which Redis instance
 * `REDIS_URL` actually points at (this repo's shared-Redis-per-namespace
 * architecture, ADR 0034, makes that a real question, not a hypothetical
 * one) — an operator could correctly confirm the intended namespace while
 * a stale or wrong `REDIS_URL` in the environment points at a live
 * deployment's own Redis. `--confirm-redis-host` closes it the same way:
 * an explicit, separate retyping, this time of `REDIS_URL`'s host only
 * (`new URL(redisUrl).host`, never the full URL) — a Redis URL routinely
 * carries a password, and a confirmation argument is a command-line
 * argument, so the host is the only part of it this check ever compares
 * or echoes back in a refusal message.
 */
export function refusalForRedis(
  redisUrl: string,
  namespace: string,
  confirmedNamespace: string | undefined,
  confirmedHost: string | undefined,
): string | undefined {
  const host = new URL(redisUrl).host;
  if (confirmedNamespace === namespace && confirmedHost === host)
    return undefined;
  return (
    `Refusing: pass both --confirm-redis-namespace ${namespace} and ` +
    `--confirm-redis-host ${host}, exactly matching REDIS_NAMESPACE and ` +
    "REDIS_URL's host, only after independently confirming this Redis " +
    'target — namespace and instance both — belongs to the isolated ' +
    'restore target, never one a live deployment still reads from.'
  );
}
