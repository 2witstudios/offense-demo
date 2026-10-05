# Database operations

Local development uses one shared Compose stack (Postgres on 15432, Redis on 6379) and a database slot per checkout ([ADR 0034](../decisions/0034-shared-stack-slots.md)). `bun slot:up` starts the stack, creates this checkout's dev, test and e2e databases if missing (`offense-demo`/`offense_demo_test`/`offense_demo_e2e` in the main checkout, `offense_demo_wt_<id>`/`offense_demo_wt_<id>_test`/`offense_demo_wt_<id>_e2e` in a worktree), migrates all three, provisions the test logins and writes their URLs into `.env`. The browser suite runs the production server as the loopback-only `offense_demo_e2e` login against the e2e database, never the test database, so integration row counts never see e2e rows; `bun slot:reset-e2e` empties it back to the baseline. `bun slot:down` drops a worktree's databases and Redis keys; `bun slot:prune` (also run by every `slot:up`) drops those of worktrees git no longer lists. Redis keys go by namespace with `SCAN` and `UNLINK`, never `FLUSHDB`. Never stop or recreate the shared stack while other checkouts use it.

Change a feature-owned schema file, run `bun db:generate`, review generated SQL and commit the new `packages/db/migrations/<timestamp>_<name>/` folder (`migration.sql` plus `snapshot.json`, the drizzle-kit 1.0 layout, [ADR 0038](../decisions/0038-drizzle-1-baseline.md)). Roles, grants and reference rows are hand-written, reviewed SQL appended to the generated migration. Use expand/contract changes for rolling deployments. Do not edit applied migrations; add a forward correction. The only sanctioned history rewrite is a greenfield baseline squash recorded in `policy/migration-baselines.json` (ADR 0023, ADR 0038), which requires resetting every local and test database once. Deploy migrations once as a release job before enabling dependent application code; do not run concurrently from every app instance. Back up production before destructive changes and test restore procedures ([restore rehearsal](restore-rehearsal.md), staging-only until a production release). Production runtime credentials must not have schema-alter privileges: the web application connects as `offense_demo_web` and the realtime service as `offense_demo_realtime`, both created by the baseline, and migrations run with the separate owner credential.

Run `bun db:migrate` with DATABASE_URL locally. In production the runner reads `MIGRATION_DATABASE_URL` (the owner) and refuses to run without it, or when it names the same role as the runtime `DATABASE_URL` (`readMigrationConfig`). Production startup refuses a `DATABASE_URL` role that can create or alter objects in schema `public` (`refuseSchemaAlteringRole` over `runtimeRoleProblems` in `packages/db`, called by `apps/web/src/server/start.ts` for `offense_demo_web` and by `apps/realtime/src/serve.ts` for `offense_demo_realtime`). On Fly the owner credential lives only in the separate migrator app, never in a runtime app's secrets ([ADR 0041](../decisions/0041-migration-credential-in-a-release-only-app.md)). The secrets and the one-time `offense_demo_web` password step are in [deploy-staging](deploy-staging.md#database-credentials). The runtime migrator (`packages/db/src/migrator.ts`) uses the native Bun driver and applies every pending migration folder in one transaction. `bun db:studio` is a local inspection tool and must not be exposed publicly. Reset (`bun db:reset`) is destructive and accepts only the current checkout's own dev and test databases, on loopback, with `ALLOW_DATABASE_RESET=yes`, never in production; it must never be part of startup. It recreates `public`, re-applies committed migrations and re-provisions the test logins (`provisionTestRoles`, the one place they are defined), so a reset never costs the browser suite its access.

**Release migrations are lock-bounded.** The release migration runs while the previous release still serves, and a DDL lock request that cannot be granted at once queues every later statement on that table behind it. The migrator's session therefore sets `lock_timeout = 1000` ms, below the runtime pool's `lock_timeout = 2000` ms, and `statement_timeout = 60000` ms, inside Fly's 5 minute release timeout (`MIGRATOR_SESSION` and `RUNTIME_SESSION` in `packages/db/src/session-bounds.ts`). A migration that cannot take its lock within 1 s fails with `55P03 lock_not_available`, the transaction rolls back, the release fails and the previous release keeps serving; app statements queued behind the lock request still get their lock inside their own 2 s bound. `packages/db/integration/migrator-lock-timeout.integration.ts` proves it against a held lock. The expand/contract rule follows: hot-table DDL (`outbox`, `session` and any table the live app writes) must take only short locks, so an `ALTER TABLE` that rewrites the table, a blocking `CREATE INDEX` or a `CREATE TRIGGER` on a busy table becomes a smaller expand step, and a release that fails on the bound is retried when the table is quiet or split up, never run with a raised timeout.

**No backfill migrations pre-ship (ADR 0018, ADR 0023).** Offense Demo has no deployed consumers, so a schema change that needs existing rows to carry a new application-owned identifier is never a data backfill: cuid2 must be minted at the application boundary (ADR 0018), and a migration cannot do that. Ship the change with no backfill and reset and re-migrate any local or test database holding older rows (`bun db:reset` — see above — reapplies every committed migration onto an empty schema, so the new write path creates rows going forward). Do not add a policy exception to reach for `gen_random_uuid()` or any other database-side generator as a substitute; reset the database instead.

**Migration concurrency:** generation is single-writer across the whole repository at a time — two branches that each run `bun db:generate` fork the snapshot chain (both new snapshots name the same predecessor). `bun migrations:check` reads the committed migrations tree of HEAD and of its merge base with `origin/main`, and fails any file outside `<timestamp>_<name>/migration.sql` and `snapshot.json` (a legacy `meta/` file included), a snapshot with no `migration.sql` beside it (the migrator would skip it silently), SQL without a snapshot, two folders sharing a timestamp, a broken `prevIds` chain, and any shared migration removed, displaced, or edited (SQL or snapshot). Resolve collisions by rebasing and regenerating the conflicting tail as a forward correction; never auto-rewrite applied migrations on `main` after the fact.

Integration tests require explicit TEST_DATABASE_URL ending in `_test`, and TEST_REDIS_URL. `bun slot:up` writes and migrates this checkout's test database; `bun slot:up` also writes TEST_REDIS_URL: the slot's own Redis database (main 1, a worktree `2 + its port block`), where every integration test uses its own `t3-` namespace; the runner refuses any other database before it deletes anything (ADR 0034). Tests use unique identifiers/namespaces and clean up only owned records. Never point them at production. Use health checks in Compose and readiness before traffic. Database pool sizing is per instance: sum of instance pool limits plus migrations/admin capacity must remain below PostgreSQL max_connections.

**Runtime roles (ADR 0032 §7, ADR 0038).** The baseline creates both
runtime roles if they are missing (`CREATE ROLE ... LOGIN`, no password), so
the migration credential needs `CREATEROLE`. Production sets their passwords
out of band, never committed.

- `offense_demo_web`, the web application's role: `SELECT, INSERT, UPDATE, DELETE`
  on every `public` table and `USAGE, SELECT` on every sequence (a
  `serial`/`bigserial` default calls `nextval()`, which table privileges do
  not cover), extended by default privileges to every table and sequence a
  later migration creates. Nothing that alters schema: no `CREATE` on
  `public`, no `TRUNCATE`, `REFERENCES` or `TRIGGER`, no access to the
  `drizzle` migration log.
- `offense_demo_realtime`, the realtime service's only credential (ADR 0032:
  "No web→realtime secret exists at all"): `SELECT` on `outbox` and a
  column-scoped `SELECT (id, user_id, expires_at)` on `session` for the 60s
  continuous re-authorization check, never `token`, the bearer credential.
  No grant on `users`. Default privileges never reach it: a migration that
  gives realtime a new read (for example the domain rows a room subscribe
  decision needs) grants exactly those columns and nothing else.
- `offense_demo_e2e`, local and CI only: the browser suite's loopback login, a
  member of `offense_demo_web` with no grant of its own, provisioned only by
  `provisionTestRoles` in `packages/db/src/slots.ts` (`bun slot:up`,
  `bun db:reset`, `bun slot:reset-e2e`, CI's `bun db:roles`). It never
  exists in production.

Integration tests connect as the migration owner, because their fixtures
and role checks need it; a test that must act as a runtime role switches to
it with `SET ROLE` on a dedicated session instead of setting a password.

**Retention.** One retention sweep in each web server
process (`apps/web/src/server/retention-sweep.ts`, at start-up and then
hourly) prunes every retained store in bounded batches: `verification` 24 h
past expiry, `outbox` 24 h after `created_at`, `email_delivery_event` 30 days
after receipt, `email_delivery` 30 days after its last status change, and
the Redis online-presence set's lapsed members. `email_suppression` is never
pruned. Every database batch is one call of `deleteExpiredBatch`
(`packages/db/src/retention.ts`): one autocommitted, oldest-first,
`FOR UPDATE SKIP LOCKED` delete of at most `RETENTION_BATCH_LIMIT` (500)
rows, never inside a transaction, so it never holds back the
`pg_snapshot_xmin` that `drainOutbox` waits on and never blocks a writer.
Each target logs `retention.sweep.completed` or `retention.sweep.failed`
with its `operation`; a failing target never stops the others.

**Outbox retention throughput.** The outbox target deletes batches
of 200 rows, up to 200 batches per run (40,000 rows/run), sized against an
expected write rate of 10 rows/s (36,000 rows/hour) so one run always clears
a full hour's growth with headroom.

Database availability is necessary but not sufficient readiness. Deployers must ensure migrations are applied, monitor storage/replication/backup lag, enforce TLS for remote database and Redis connections, and set network access policy. Local plaintext credentials are intentionally confined to loopback. Redis persistence is off locally to expose accidental reliance on durable cache state.
