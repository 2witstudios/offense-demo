/**
 * `bun scripts/post-restore-invalidate.ts`: AUTH-7.6's post-restore step,
 * the command the restore runbook (`docs/operations/restore-rehearsal.md`)
 * invokes before a restored database takes traffic. Deletes every session
 * and verification row (`Database.purgeAllForRestore`) and clears the auth
 * rate-limit counters of one Redis namespace (`clearAuthRateLimits`), so a
 * pre-restore session cookie or emailed link can never authenticate against
 * the restored copy, and prints only row counts — never a connection
 * string, a token or a secret.
 *
 * Refuses by default unless `DATABASE_URL`'s database name contains
 * "restore": this command is destructive to every session and verification
 * row in whatever database it points at, so it must never be pointed at a
 * database still serving traffic (a naming mistake is the one failure mode
 * a database name check can catch). `--force` overrides the name check for
 * an isolated database that does not happen to carry "restore" in its name;
 * it never overrides anything else. That URL-string check runs before any
 * connection opens, but it is not the last word: a `?database=` query
 * parameter on the same URL overrides which database Bun's `SQL` client
 * actually connects to, so after connecting this also checks
 * `Database.currentDatabaseName()` (`current_database()`, the server's own
 * answer) against the same rule — the one check that cannot be fooled by
 * the connection string.
 *
 * The Redis target is guarded separately and unconditionally: a real
 * restore's `REDIS_NAMESPACE` need not contain "restore" (a blue/green
 * restore can reuse the live namespace on purpose), so there is no name
 * pattern to infer isolation from. `--confirm-redis-namespace <namespace>`
 * and `--confirm-redis-host <host>` must each retype the exact value of
 * `REDIS_NAMESPACE` and of `REDIS_URL`'s host (never the full URL, which
 * routinely carries a password) — two explicit, deliberate confirmations
 * an operator only gives after independently confirming that Redis target
 * belongs to the isolated restore copy — `--force` never substitutes for
 * either.
 */
import { RedisClient } from 'bun';
import { systemId } from '@offense-demo/clock';
import { createDatabase } from '@offense-demo/db';
import { clearAuthRateLimits } from '@offense-demo/redis/namespaces';
import {
  refusalFor,
  refusalForActualName,
  refusalForRedis,
} from './restore-guard';

const args = process.argv.slice(2);
const force = args.includes('--force');
const flagValue = (flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const confirmedRedisNamespace = flagValue('--confirm-redis-namespace');
const confirmedRedisHost = flagValue('--confirm-redis-host');

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const redisNamespace = process.env.REDIS_NAMESPACE;

if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!redisUrl) throw new Error('REDIS_URL is required');
if (!redisNamespace) throw new Error('REDIS_NAMESPACE is required');

const refusal = refusalFor(databaseUrl, force);
if (refusal) throw new Error(refusal);

const redisRefusal = refusalForRedis(
  redisUrl,
  redisNamespace,
  confirmedRedisNamespace,
  confirmedRedisHost,
);
if (redisRefusal) throw new Error(redisRefusal);

const database = createDatabase({
  url: databaseUrl,
  nextActorId: systemId.next,
});
const redis = new RedisClient(redisUrl);

try {
  const actualDatabaseName = await database.currentDatabaseName();
  const actualRefusal = refusalForActualName(
    actualDatabaseName,
    'restore',
    force,
  );
  if (actualRefusal) throw new Error(actualRefusal);

  const purged = await database.purgeAllForRestore();
  const clearedRateLimitKeys = await clearAuthRateLimits(redis, redisNamespace);
  console.log(
    JSON.stringify({
      database: actualDatabaseName,
      redisNamespace,
      deletedSessions: purged.sessions,
      deletedVerifications: purged.verifications,
      clearedRateLimitKeys,
    }),
  );
} finally {
  await database.close();
  redis.close();
}
