# 0034: One shared local stack with derived per-checkout slots

Status: accepted. Supersedes the per-session Compose stacks that
`docs/development/local-development.md` and `parallel-work.md` described.
Amended by the test-state sections below and by
[ADR 0038](0038-drizzle-1-baseline.md): each slot
has a third database for the browser suite, the template database is
gone (slot databases copy `template0`), and the e2e login's access is its
membership in `offense_demo_web`.

## Context

Parallel sessions each started their own Compose project, named by hand
(a chosen stack name and custom ports). Nothing tore a project down: removing a
worktree left its containers and volume behind, and nothing linked a
hand-picked stack name back to its worktree. On 2026-09-22 two of five
running stacks had no owner, 13 orphaned Postgres volumes held about 1.9 GB,
and five of eight worktrees had set no stack name at all, so they silently
shared (and restarted) the main checkout's stack. The databases themselves
are tiny (`offense-demo` 9 MB, `offense_demo_test` 15 MB).

## Decision

- **One stack.** `infra/compose.yaml` has the fixed project name `offense-demo` and
  fixed loopback ports (Postgres 15432, Redis 6379). Postgres runs with
  `max_connections=300` because every checkout's dev server, test pools and
  e2e server share it. There are no stack-name or port knobs.
- **Slots are derived, never chosen.** A checkout's slot comes from its
  folder (`scripts/slot-model.ts`, a pure tested function). The main
  checkout is slot `offense-demo`: databases `offense-demo` and `offense_demo_test`, Redis
  namespaces `offense-demo` and `offense-demo-e2e`. A git worktree folder such as
  `wt-3ctbm0tw` is slot `3ctbm0tw`: databases `offense_demo_wt_3ctbm0tw` and
  `offense_demo_wt_3ctbm0tw_test`, namespaces `offense-demo-wt-3ctbm0tw` and
  `offense-demo-wt-3ctbm0tw-e2e`. Ids are lowercase words joined by single
  underscores, at most 28 characters so every namespace fits
  `REDIS_NAMESPACE`, and may not end in `_test` or `_e2e`, so every
  database and namespace name maps back to exactly one slot. Any other
  folder name is refused, never normalised into something else.
- **Template database.** `offense_demo_template` holds what a fresh slot needs
  before migrations: the `offense_demo_e2e` role's schema usage and default table
  and sequence privileges. It accepts no connections, so copying from it
  never fails with "source database is being accessed". It holds no schema:
  each slot runs its own branch's migrations. `bun slot:up` creates the role
  and the template when missing; there is no Docker init script, so one
  code path sets up new and existing volumes alike.
- **`bun slot:up`** (idempotent) brings the shared stack up, prunes orphans,
  creates the slot's databases from the template, migrates both, and writes
  the slot's values into the checkout's `.env`: `DATABASE_URL`,
  `TEST_DATABASE_URL`, `REDIS_NAMESPACE`, `E2E_DATABASE_URL`,
  `E2E_REDIS_URL`, `E2E_REDIS_NAMESPACE`, `TEST_REDIS_URL`, `PORT`,
  `PUBLIC_APP_URL` and `E2E_PORT`. Host, port and credentials are kept from the existing URLs, so
  the admin connection is whatever the `.env` names. A worktree's ports come
  from a port block claimed in the comment on its dev database: shared by
  every checkout and deleted with the database.
- **`bun slot:down`** drops the worktree's databases and deletes its Redis
  keys, including every `t3-` namespace in its test Redis database. It refuses the main checkout.
- **`bun slot:prune`** (and the start of every `slot:up`) drops the
  `offense_demo_wt_*` databases and `offense-demo-wt-*` namespaces of worktrees that
  `git worktree list` no longer shows (a `prunable` entry, whose folder is
  gone, counts as removed). Names that do not parse as a worktree slot are
  never touched. Redis keys are removed with `SCAN` and `UNLINK` over the
  exact `<namespace>:*` pattern, never `FLUSHDB`/`FLUSHALL`.
- **Local stack only.** Slot tooling force-drops databases and unlinks
  namespaces, so it refuses a `.env` whose `DATABASE_URL`, `REDIS_URL` or
  `E2E_REDIS_URL` names anything but loopback, before touching Docker or
  any service.
- **Each checkout migrates itself.** `slot:up` runs the selected checkout's
  own `packages/db/scripts/migrate.ts`, so a branch behind or ahead of the
  one running the tool gets exactly its own schema.
- **Identifiers are allowlisted.** Database names and literals in
  `CREATE`/`DROP`/`COMMENT`/`CREATE ROLE` cannot be bound as parameters;
  `@offense-demo/db/slots` checks each against a strict pattern before quoting it,
  and `@offense-demo/redis/namespaces` refuses any namespace with glob or separator
  characters.
- **Guards.** `bun doctor` fails when `.env` names another slot's database
  or namespace (a `.env` copied from the main checkout) and warns about
  orphaned slots. `bun db:reset` accepts only the current slot's two
  databases on loopback and restores the `offense_demo_e2e` grants after
  recreating `public`.
- **E2E.** The Playwright config takes `E2E_DATABASE_URL`, `E2E_REDIS_URL`
  and `E2E_REDIS_NAMESPACE` explicitly (CI sets them in `e2e.yml`). A
  missing value is passed as empty and the server refuses to start, so the
  suite never falls back to another checkout's data.

## Test state never outlives a run

The owner's bar (2026-09-29): a killed, crashed or timed-out integration run
must never leave state behind in the shared stack. Both stores that
integration suites write to meet it the same way, by construction rather than
cleanup: Redis by giving each slot a logical database of its own with bounded,
swept keys, Postgres by giving each run a database of its own that is dropped.
One rule covers both: a suite obtains its services only from
`requireTestServices`, which refuses any Redis that is not the slot's own
database on its own server and any Postgres that is not the database the
runner made for this run, so a file started by hand can neither leak nor
delete anything outside its own slot.

### Redis: one logical database per slot

On 2026-09-29 the test Redis (database 1, shared by every checkout) held
78,208 stale `t3-*` keys from 85 runs. Teardown and every SCAN walk the whole
keyspace, so they slowed with other people's keys until the namespaces
SCAN test timed out and blocked other checkouts' `bun verify`. An earlier fix made
a normal teardown delete its namespace; a crashed, killed or timed-out run
still leaked, and cost still scaled with everyone else's keys. The rule is
now that leaked test state cannot happen, by three mechanisms and one
isolation choice.

- **Isolation: a Redis logical database per slot.** Main keeps database 1
  (CI's too); a worktree slot's integration suites use database `2 + its port
block` (3 to 501), written to `TEST_REDIS_URL` by `slot:up`. The port block
  is already claimed in the slot database's comment and released when
  `slot:down` or a prune drops that database, so there is no second claim store.
  Dev (0), main's test (1) and the browser suite (2) are unchanged. A slot's
  SCAN, `deleteNamespace` and sweep walk only its own database, so their cost
  is independent of every other slot. `infra/compose.yaml` starts Redis with
  `--databases 512`; `slot:up` reads `CONFIG GET databases` and refuses a
  server with too few, naming the one-time
  `docker compose -f infra/compose.yaml up -d --force-recreate redis`.
  `slot:up` never recreates a running stack itself (that would drop every
  checkout's Redis state), so the operator runs it once. Every path that
  writes or deletes test keys checks that `TEST_REDIS_URL` names exactly the
  slot's own database (main 1, a worktree `2 + block`, derived from `PORT`)
  on the slot's own Redis server (the host and port `REDIS_URL` names; any
  spelling of this machine is the same server), and refuses anything else:
  dev (0), e2e (2), another slot's, past the server's 512, or another
  server. `requireTestServices`, which every suite
  must call, carries the check, so running any integration file directly
  against the wrong Redis refuses at import; `bun doctor` reports the
  mismatch; the runner (which calls the same function) exits before its
  sweep or post-run scan; `slot:down` opens no client. An integration file
  reaches Redis only through `openTestRedis` (`@offense-demo/redis/testing`), which
  accepts only a URL `requireTestServices` returned, and what it returns is
  not a Redis client: a frozen object with no prototype, so no
  `constructor` to build a raw client from and no handle to reach one, whose
  only members (`send`, `get`, `getdel`, `del`, `exists`, `pttl`, `ping`,
  `connect`, `close`, `connected`) each go through one allowlist. A command
  outside the allowlist is refused, so FLUSHDB, FLUSHALL, SELECT, SWAPDB, MOVE,
  CONFIG and DEBUG are refused however they are spelled, and so is any SCAN or
  KEYS whose pattern does not begin with a literal `t3-` test namespace and at
  least six literal id characters (no `*`, `**`, `?*`, `[a-z]*`, short prefix
  or missing MATCH gets through). A test runs no Lua: EVAL, EVALSHA, SCRIPT and
  FUNCTION are refused on it, and the client code under test gets
  (`createBoundedTestClient`, the same shape) runs only scripts the adapter
  registered with `defineScript`. Lint catches the same shapes in source, and
  adds the routes to a raw client that source can name: a `bun` import of
  `RedisClient` or `redis` (type-only is fine), aliased, namespaced, dynamic or
  `require`d, `Bun.redis` and `Bun['redis']`, destructuring them, a
  `.constructor` access, a command that is not a string literal. The one
  whole-database operation, `deleteAllKeysWithoutExpiry`, is in `scripts/`,
  in no package's `exports`, and the boundary check refuses any workspace file
  that imports from `scripts/`: the runner calls it on a raw
  client after the check, so a hand-edited `.env` can never make a run delete
  another database's keys.
- **Documented limits of the Redis test guard.** What lint and the wrapper
  cannot see, stated rather than pretended: a test file that opens its own
  socket to the Redis port (`Bun.connect`, `node:net`) or imports a Redis
  client library other than Bun's (the boundary check refuses an undeclared
  dependency, but a declared one would pass); code under test that is itself
  wrong, since the registered scripts and the adapter are trusted; a test that
  disables the lint rule for a line (review catches it, lint does not); the
  Bun global reached by a route lint does not name (a function that returns
  it, `Reflect.get(globalThis, 'Bun')`, a `with` block: the aliases
  `const B = Bun`, `globalThis.Bun` and `{ Bun: B } = globalThis` are flagged,
  and `Bun.redis` through them); and the slot's own other namespaces, which a pattern anchored at a namespace id
  of another concurrent run of this slot can still name. None reaches another
  slot's, dev's or e2e's keys: `requireTestServices` pins the URL to this
  slot's database on this slot's server before any of it runs.
- **Why not per-namespace key tracking.** Tracking each run's keys in a set
  needs every write attributed to a namespace at the seam: the presence
  scripts build a hash key inside Lua, and the slot tooling must still SCAN
  production-shaped namespaces it never tracked. The namespaces SCAN test
  would also still walk the shared keyspace, which is the cost that failed.
  A logical database removes the shared keyspace instead of indexing it.
- **Every test key expires.** `@offense-demo/redis/testing` wraps a client so that a
  `SET` with no expiry is sent as `SET... PX <ceiling>` and every other write
  (a key-first command or an `EVAL`/`EVALSHA` with declared keys) is followed
  by a script capping the touched keys' TTL at the ceiling, two hours: well
  past the one-hour maximum run. A write whose keys it cannot attribute is
  refused before it is sent, and so is a client helper that could bypass the
  wrapper. `createTestApp` hands the composed app this client (`createApp`'s
  `redisClient`), and `withRedis` does the same for the package's suites.
  After every run the runner scans the database and fails, naming the keys, if
  any has no expiry, then removes them.
- **Self-healing on every run.** Every test namespace is `t3-<id>`
  (`testNamespace`). Before a workspace's suites start, the runner removes
  every `t3-` namespace whose newest key (`OBJECT IDLETIME`) has been idle
  longer than the maximum run length. A run in progress keeps a fresh key, so
  concurrent workspaces in the same slot are safe, and no other slot's
  database is touched. The rule ignores TTLs, so it also clears an immortal
  key a killed run wrote in the window between a write and its cap.
- **Release.** `slot:down` deletes the slot's `t3-` namespaces. A prune of an
  orphaned worktree does not open its test database: its keys expire within
  two hours and the next slot to claim that block sweeps any remainder.
- **Postgres** has the same guarantee, by a different mechanism: see the next
  subsection.

The proof is `bun proof:test-redis` against a throwaway Redis: 100,000
foreign keys in another slot's database leave teardown and the SCAN test
within their baseline over 10 runs, the same keys in one shared database slow
both several times over (the negative control), and a SIGKILLed run leaves
nothing that survives the next sweep.

### Postgres: one database per run

The row ledger compares a run's row counts before and after and fails
a suite that grew a table. It cannot see a run that never reached the end: a
SIGKILL, a crash or a CI timeout skips every `afterAll`, and the rows it left
(730 `verification` rows, measured 2026-09-29) become the next run's baseline,
so nothing ever reports or removes them. The rule is that a killed run leaves
no row that survives, by construction rather than by cleanup.

- **A database per run.** `scripts/test-integration.ts` creates
  `<slot test database>_run_<8 hex digits from the CSPRNG>` from `template0`
  (for `offense_demo_wt_3ctbm0tw_test`: `offense_demo_wt_3ctbm0tw_test_run_0a1b2c3d`),
  migrates it with the checkout's own migrator, runs the workspace's suites
  with `TEST_DATABASE_URL` pointing at it, checks the row ledger against it
  and drops it. Rows can only be written to a database that is dropped, so no
  suite, however it exits, leaves rows in a database anyone else reads. The
  ledger stays: a suite that leaves rows in its run database still fails the
  run. Because every run migrates an empty database, every run
  also proves the migrations apply from nothing.
- **Liveness is a lock, not a clock.** The runner claims the name with a
  session advisory lock (`pg_try_advisory_lock(hashtextextended(name, 0))`) on
  one admin connection it holds for the whole run, before it creates the
  database. Postgres releases the lock the moment that connection ends,
  however the runner died. Before a run creates its own database it drops
  every run database of its slot whose lock is free and that has no session
  younger than the longest a run may last (`TEST_RUN_MAX_MS`, one hour;
  `DROP DATABASE... WITH (FORCE)`). A suite process that outlives a
  SIGKILLed runner is left to finish while its sessions are within that
  bound, so a run that lost its lock is never dropped under its suite; a
  suite that hangs past the bound has its sessions terminated by the forced
  drop and its database removed, rows and all, so a hung orphan cannot keep a
  run database indefinitely. A live run, in this
  workspace's sibling run or another process, holds its lock and is never
  touched, and the runner caps every run at that same bound (it kills the
  suites and fails the run), so a run older than the bound that
  lost its lock is one the runner is about to stop anyway. If a
  sweep runs in the few milliseconds before Postgres notices a dead runner,
  it skips that database and the next run drops it.
- **A lost lock stops the run.** The lock belongs to one
  backend, and Bun silently reconnects a connection Postgres cut, which would
  hold no lock. The runner therefore runs the suites as a child it supervises:
  every 500 ms it checks that the admin connection is still the backend that
  claimed the database (a query that fails on the dead connection counts as
  lost), and on a loss it kills the suites and fails the run with a named
  error, rather than let a concurrent sweep decide the run is dead. Two more
  layers cover the moments before the runner notices: the sweep never drops a
  database that any other session is connected to, and the check runs once
  more when the suites exit. Proven by killing the runner's lock session
  mid-run (`bun proof:test-postgres`): the run stops loudly, and the sweeps
  run meanwhile never drop its database.
- **Why not a row sweep.** Sweeping fixture rows by prefix and age would
  need every table's cascade and every future table's registration; a table
  someone forgets would leak again. Dropping a database has no such list. A
  per-run schema was rejected for the same reason plus the migrator: it is
  written for `public`.
- **A suite cannot start by hand, and cannot reach another database.
  ** `requireTestServices` accepts a Postgres URL only when its
  server (host and port; any spelling of this machine is the same server) is
  the one `DATABASE_URL` names, its database is `<this slot's test
database>_run_<8 hex digits>` (the slot is told from `DATABASE_URL`, which
  `slot:up` writes), and it is exactly the database named by
  `TEST_RUN_DATABASE`, which the runner sets for its suites and nothing else
  does. So `bun test` on a suite file, another slot's or main's run
  database, another run of this slot, and a well-formed name on another
  server are all refused at import, naming the rule and never a host. The
  runner's own reader (`requireTestSlotServices`) holds the slot's `_test`
  database to the same slot and server rule before it creates or drops
  anything. Someone who edits both `TEST_DATABASE_URL` and `TEST_RUN_DATABASE`
  by hand to another run of the same slot, on the same server, is not told
  from that run; only the database's liveness lock could, and a suite does not
  hold a connection to it. The runner takes a suite file as an argument
  (`bun../../scripts/test-integration.ts integration/x.integration.ts` from
  the workspace) and gives it a run database like any other.
- **The slot's `_test` database remains** as the name run databases derive
  from and the target of `bun verify`'s migration-idempotency gate and
  `bun db:reset`; no suite writes to it. `_test_run_<8 hex>` is a reserved
  suffix in slot ids, and a run database maps back to its slot, so a prune
  never drops a live slot's runs and drops an orphaned slot's with it.
  `bun slot:down` drops the slot's run databases first.
- **Obsolete, removed.** An earlier advisory lock refused a second
  concurrent apps/web run against one test database. Runs no longer share a
  database, so the lock and its module are gone, and two runs of one slot can
  proceed side by side.
- **Cost and limits.** Migrating and dropping a run database took about a
  second on a developer machine. CI needs nothing new: its Postgres user
  creates databases. Postgres holds a database per live run, so a run of the
  whole suite needs a few more connections than before, well inside
  `max_connections=300`.

The proof is `bun proof:test-postgres`: a real run of the mail-ceilings suite
is SIGKILLed mid-suite (runner and suite process); its rows are in its run
database and not in the slot's `_test` database; the next clean run drops it,
passes, keeps the ledger flat and leaves no run database; a concurrent run
never drops a live run's database; and a suite started by hand is refused.

## Consequences

- Removing a worktree leaves nothing running: its data goes on the next
  `slot:up` anywhere, or `slot:prune`, or its own `slot:down` at handoff.
- Every checkout depends on one stack; stopping it stops everyone. The
  scripts therefore offer no `infra:down`.
- The stack is per machine but pruning only knows its own repository's
  worktrees: two clones of this repository on one machine would each prune
  the other's worktree slots and share the main slot. Use worktrees of one
  clone, never a second clone.
- `slot:up` starts Compose only when the stack is unreachable, so a branch
  whose compose file differs never recreates the running shared stack;
  changing the stack's configuration is a deliberate operator step.
- Pruning reads `git worktree list` under the slot lock, so a worktree
  created and slotted while another `slot:up` waited is never pruned.
- Two worktree folders that derive the same id (`a-b` and `a_b`) are
  refused rather than allowed to share a slot.
- Migration generation is still single-writer (`bun migrations:check`); each
  slot only applies its own branch's migrations to its own databases.

## Upgrade path

Copy-on-write cloning (Postgres 18 `file_copy_method = clone`) needs a
reflink filesystem. Docker Desktop's ext4 VM is not one, and at a few MB per
database a plain template copy takes well under a second, so it is not
pursued. If slot databases grow large, move the data directory to a reflink
filesystem and set `file_copy_method = clone`; the slot model is unchanged.
