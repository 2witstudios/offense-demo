# Backup, restore and post-restore rehearsal

Staging-only rehearsal proving `offense_demo_staging` can be dumped and
restored into an isolated database with every FK relationship intact, and
that the post-restore step makes a pre-restore session cookie or emailed
link unable to authenticate before the restored copy takes traffic.
The release-environment backup criterion (encrypted backups, RPO 1h, RTO
4h) belongs to the production release; this rehearsal proves the mechanics
only, never against production. Counts and outputs below are what a
passing rehearsal shows with the committed seed; record your own run's
evidence in the handoff, not here.

## Postgres access

Staging Postgres (`offense-demo-staging-db`) is a single Fly machine with no
external endpoint; every command below runs inside it over
`fly ssh console`, never from an operator's own machine, so the superuser
credential (`$OPERATOR_PASSWORD`, already present in that machine's own
environment) never leaves it:

```
fly ssh console -a offense-demo-staging-db -C "sh -c 'echo <base64 script> | base64 -d | sh'"
```

The script inside uses `PGPASSWORD="$OPERATOR_PASSWORD"` with `psql`,
`pg_dump`, `pg_restore`, `createdb` and `dropdb` — never prints the
password, and the base64 wrapper only avoids quoting problems over SSH, not
secrecy (the script text itself holds no secret). Every concrete instance
below pipes the encode step through `tr -d '\n'`: GNU `base64` (a Linux
operator host) wraps its output at 76 characters by default, unlike BSD
`base64` (macOS), and an embedded newline inside the `-C` argument corrupts
the command `fly ssh console` sends over SSH — `tr -d '\n'` produces one
line on either platform. Evidence below is limited to table names, row
counts and exit codes.

## 1. Synthetic content

Start from a staging database with no rehearsal rows (row counts per
table). `scripts/staging-restore-seed.ts` creates a
representative slice — synthetic, never real personal data:

- Two users (`restore-rehearsal-a@example.test`,
  `restore-rehearsal-b@example.test`, RFC 2606 reserved domain, never
  delivered), both `emailVerified: true`
- One session and one passkey per user, one verification token
- Any domain fixtures your project adds to `applyDevSeed`; extend the count
  and join tables below with them

It runs through `@offense-demo/db`'s `applyDevSeed` adapter operation for the
users (with optional `email`/`emailVerified` fields) and direct inserts for `session`/`passkey`/`verification`,
which `applyDevSeed` does not cover. Idempotent in row identity, like
`applyDevSeed`: rerunning creates no new row — the session and verification
rows' credential columns are the deliberate exception, refreshed to a new
CSPRNG value every run. Both the session token and the verification token
are fresh CSPRNG values, generated inline and discarded immediately, never
bound to a name that outlives the expression (`scripts/restore-seed-token.ts`).
Its unit tests (`scripts/restore-seed-token.test.ts`) verify the values this
produces — never the historical leaked literal, never repeated across
calls, full CSPRNG length — not the absence of a log call or a stored copy,
which a unit test cannot observe; that guarantee comes from the source
never binding the token to a variable that outlives the expression, plain
to see by reading the two call sites. Runs from the staging web machine itself
(`fly ssh console -a offense-demo-staging`), using that machine's own
`DATABASE_URL` (the `offense_demo_web` runtime role, which already holds
`INSERT`/`UPDATE`/`DELETE` on every table) — never the migration owner
credential.

`scripts/staging-restore-seed.ts` imports two sibling files
(`./restore-guard`, `./restore-seed-token`) that do not exist on the
deployed web image outside `scripts/`, so copying the script alone fails
with `Cannot find module './restore-guard'`. Bundle it first — `bun build`
inlines both siblings and leaves `@offense-demo/db` external, since that package
is already a real dependency in the image's `node_modules` — then run the
single resulting file the same way:

```
bun build --target=bun --external @offense-demo/db scripts/staging-restore-seed.ts --outfile=/tmp/staging-restore-seed-bundle.js
fly ssh console -a offense-demo-staging -C \
  "sh -c 'set -e; trap \"rm -f /app/apps/web/tmp-seed.js\" EXIT; echo $(base64 < /tmp/staging-restore-seed-bundle.js | tr -d '\n') | base64 -d > /app/apps/web/tmp-seed.js && cd /app/apps/web && bun tmp-seed.js'"
```

`set -e` fails the whole command on a decode or seed error; the `EXIT` trap
removes the temporary file on every path, success or failure. A passing run
prints `Restore rehearsal seed version: restore-rehearsal-seed-v1`, and
the resulting `verification` row's `identifier` is a proper
`sign-in:<sha3-256 hex>` value, never the raw token.

Verified row counts after seeding, `offense_demo_staging`:

| Table          | Count |
| -------------- | ----- |
| `users`        | 2     |
| `passkey`      | 2     |
| `session`      | 2     |
| `verification` | 1     |

FK joins on the source, all matching the row counts above:
`users ⋈ passkey` = 2, `users ⋈ session` = 2.

## 2. Backup

```sql
pg_dump -h localhost -U postgres -d offense_demo_staging -Fc -f /tmp/staging-rehearsal.dump
```

Custom format (`-Fc`).

## 3. Restore into an isolated database

Never over `offense_demo_staging`. `offense_demo_restore_rehearsal`, on the
same machine, dropped at the end of the rehearsal:

```sql
dropdb -h localhost -U postgres --if-exists offense_demo_restore_rehearsal
createdb -h localhost -U postgres offense_demo_restore_rehearsal
pg_restore -h localhost -U postgres -d offense_demo_restore_rehearsal --no-owner --no-privileges /tmp/staging-rehearsal.dump
```

Exit code 0. `--no-owner --no-privileges` because the restore target has no
`offense_demo_web`/`offense_demo_migrator` roles of its own — this rehearsal proves data
and relationships survive a restore, not role provisioning (a real recovery
restores into a database whose roles the baseline migration already
created).

## 4. Proof: relationships survived

Row counts, `offense_demo_restore_rehearsal`, identical to the source
table above (`users` 2, `passkey` 2, `session` 2, `verification` 1). FK
joins on the restored copy: `users ⋈ passkey` = 2, `users ⋈ session` = 2 —
every relationship the source held, held on the restored copy.

## 5. Post-restore step: proof it disables pre-restore auth

`bun scripts/post-restore-invalidate.ts` (`packages/db`'s
`Database.purgeAllForRestore` plus `@offense-demo/redis/namespaces`'s
`clearAuthRateLimits`) is the committed, tested implementation of this
step, run against the restored database's `DATABASE_URL` and
`REDIS_URL`/`REDIS_NAMESPACE` before it takes traffic:

```
DATABASE_URL=<restore copy> REDIS_URL=<its redis> REDIS_NAMESPACE=<its namespace> \
  bun scripts/post-restore-invalidate.ts \
  --confirm-redis-namespace <its namespace> \
  --confirm-redis-host <its redis host, e.g. host:port>
```

**This does not run on `offense-demo-staging-db` or `offense-demo-staging`
themselves — three separate reasons, any one of which alone would block
it**: `offense-demo-staging-db` has no repository checkout and no `bun`
(it is a bare Postgres machine); `offense-demo-staging`'s deployed image
has no `scripts/` directory (the Next.js production build output only,
never the repo root); and even given a way to run it, the restored copy
(`--no-owner --no-privileges`, section 3) grants nothing to `offense_demo_web` —
that role does not exist as a grantee on this ad hoc database at all, so it
could not `DELETE` from `session`/`verification` even if the script could
reach it. "On staging" below is the real staging procedure until one of the three
blockers above is removed (a runner image with the repo, or a role
explicitly granted on every restored copy — neither exists today, so this
is not a placeholder).

The script itself refuses unless the database name contains "restore"
(`--force` overrides for a database independently confirmed isolated) — a
naming-mistake guard, tested in `scripts/restore-guard.test.ts`. The Redis
target is guarded separately, by two confirmations: `--confirm-redis-namespace`
must retype `REDIS_NAMESPACE`'s exact value, since a real restore's
namespace need not contain "restore" at all (a blue/green restore can reuse
the live namespace on purpose) — there is no name pattern to infer
isolation from, so the operator states it explicitly instead. Confirming
the namespace alone still leaves a gap: this repo's Redis is shared per
environment and isolated only by namespace (ADR 0034), so a correctly
confirmed namespace says nothing about whether `REDIS_URL` itself points at
that same live deployment's Redis rather than an isolated one —
`--confirm-redis-host` closes it, retyping `REDIS_URL`'s host only (never
the full URL, which routinely carries a password a command-line argument
must never hold).

The full real-path proof of the script's own logic is
`apps/web/integration/auth-restore-invalidation.integration.ts`: a real
sign-in through the mounted routes, a real session cookie, a real,
unredeemed magic-link token, a real rate-limit key, then
`purgeAllForRestore`/`clearAuthRateLimits` exactly as the script runs them,
then each artifact replayed against the real seam that would have accepted
it — the session cookie against `identify`, the magic-link token against
the real `/auth/confirm` redemption path, the rate-limit key against Redis
directly. RED without the purge (`identify` still resolves `provisional`,
the verification row still exists), GREEN with it (`identify` resolves
`anonymous`, the redemption is rejected exactly as a replayed/invalid
token is, the rate-limit key is gone).

`bun scripts/post-restore-invalidate.ts` (`bun restore:invalidate`) can
also be run end to end locally, not only through the functions it calls:
seed this checkout's own dev database with
`scripts/staging-restore-seed.ts --force`, `pg_dump`/`pg_restore` it into an
isolated `offense_demo_wt_<id>_restore_proof` database (same local Postgres
container, `docker exec offense-demo-postgres-1 pg_dump`/`pg_restore`), then run the
real command:

```
DATABASE_URL=postgres://offense_demo:...@localhost:15432/offense_demo_wt_<id>_restore_proof \
REDIS_URL=redis://localhost:6379/1 REDIS_NAMESPACE=offense-demo-wt-<id>-restore-proof \
  bun restore:invalidate \
  --confirm-redis-namespace offense-demo-wt-<id>-restore-proof \
  --confirm-redis-host localhost:6379
```

Output: `{"database":"offense_demo_wt_<id>_restore_proof","redisNamespace":"offense-demo-wt-<id>-restore-proof","deletedSessions":2,"deletedVerifications":1,"clearedRateLimitKeys":0}`.
The source dev database keeps its own 2 sessions and 1 verification row
afterward; confirm by direct query, then drop the isolated database and
dump file.

### On staging: the actual procedure

The equivalent of `purgeAllForRestore` — the same two statements, in the
same one transaction — run directly against the restored copy as the
Postgres superuser, over `fly ssh console`, the same access pattern this
whole document uses for every other staging Postgres command; it needs no
repo, no `bun`, and no privilege the restore did not already grant the
superuser as the restore's owner. A `current_database()` guard runs first,
inside the same transaction as both deletes — the guard and the deletes
succeed or fail together, so a copy-pasted `-d` naming the wrong database —
`offense_demo_staging` itself, say — aborts the whole transaction before
either `DELETE` commits, not only when `ON_ERROR_STOP` happens to be set,
the same defense-in-depth `refusalForActualName` gives the committed
script:

```
purge_sql=$(mktemp)
cat > "$purge_sql" <<'SQL'
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'offense_demo_restore_rehearsal' THEN
    RAISE EXCEPTION 'refusing: current_database() is %, not the restored copy', current_database();
  END IF;
END $$;
DELETE FROM session;
DELETE FROM verification;
COMMIT;
SQL
fly ssh console -a offense-demo-staging-db -C \
  "sh -c 'echo $(base64 < "$purge_sql" | tr -d '\n') | base64 -d | PGPASSWORD=\"\$OPERATOR_PASSWORD\" psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d offense_demo_restore_rehearsal -f -'"
rm -f "$purge_sql"
```

Against `offense_demo_restore_rehearsal` this removes 2 sessions and 1
verification row. Before: the seeded session's token matches exactly one
`session` row. After: zero rows match that token — the same token a
client's cookie would carry can no longer resolve to a session, exactly as
the integration test proves through the real HTTP path. Check
`offense_demo_staging` (the live source) immediately after: it must still hold its
original 2 sessions and 1 verification row — the invalidation never touches
anything outside the isolated copy.

There is no isolated Redis namespace in this rehearsal to run
`clearAuthRateLimits`'s equivalent against — this exercise dumps and
restores Postgres only, and Redis holds no durable state a backup would
need to restore (rate-limit counters and presence data are expected to
reset, never to survive a restore). `clearAuthRateLimits`'s own logic is
proven above, against a real Redis, by both the integration test and the
local `bun restore:invalidate` run. A real disaster recovery that also
provisions an isolated Redis namespace for the restored copy would clear it
the same way this section clears Postgres: the raw commands
(`SCAN MATCH <namespace>:v1:rl:*`, then `UNLINK` on the matched keys, as
`clearAuthRateLimits` itself does) run wherever that Redis is actually
reachable from, never by assuming the committed script itself can run
against the restore target.

## 6. Cleanup

```sql
select pg_terminate_backend(pid) from pg_stat_activity where datname = 'offense_demo_restore_rehearsal' and pid <> pg_backend_pid();
dropdb -h localhost -U postgres --if-exists offense_demo_restore_rehearsal
rm -f /tmp/staging-rehearsal.dump
```

Confirm `offense_demo_restore_rehearsal` is absent from `pg_database` and the dump
file is gone. The synthetic seed rows in `offense_demo_staging` (users,
passkeys, the verification row) are left in place
deliberately — representative content for the next rehearsal or for
exercising staging by hand, not a leftover to clean up. Their `session`
rows do not stay in that state: the secret-rotation rehearsal's emergency
`BETTER_AUTH_SECRET` step (`secret-rotation-rehearsal.md`) deletes
every `session` row on staging, these included — rerunning
`scripts/staging-restore-seed.ts` recreates them.

## Reproducing this rehearsal

1. Confirm the target is staging, never production, for **both** apps the
   rehearsal touches: `fly status -a offense-demo-staging-db` names the
   database app step 2 restores, and, separately, confirm the **web app's
   own** `DATABASE_URL` (the one section 1's seed command actually runs
   under) points at `offense_demo_staging` and not some other database —
   checking the database app alone says nothing about which database the
   web app's seed step writes to. Never `printenv DATABASE_URL` for this:
   that prints the `offense_demo_web` password to the terminal. Print only the
   database name instead, exactly what `scripts/staging-restore-seed.ts`'s
   own guard checks:
   ```
   fly ssh console -a offense-demo-staging -C "bun -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))'"
   ```
2. Seed if the row counts in step 1 come back zero.
3. Run steps 2–4 verbatim; halt before step 5 if any count mismatches.
4. On staging, run step 5's "On staging" procedure against the isolated
   copy only, never `bun scripts/post-restore-invalidate.ts` directly — it
   cannot reach `offense-demo-staging-db`. Where the target is a database
   the script itself can reach (this checkout's own dev database, or any
   future restore target with a repo and a granted role), run the script
   instead: `scripts/restore-guard.ts` refuses a `DATABASE_URL` without
   "restore" in the database name for exactly this reason, and separately
   refuses to touch Redis at all unless `--confirm-redis-namespace` and
   `--confirm-redis-host` each retype the exact `REDIS_NAMESPACE` and
   `REDIS_URL` host in use.
5. Always run step 6, even after a failure partway through.
