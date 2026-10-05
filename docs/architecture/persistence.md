# Persistence and ephemeral infrastructure

Platform/data owners maintain `@offense-demo/db`; application features call its public operation API. Drizzle and Bun SQL stay private. Tables are organized by record ownership, one schema file per area under `packages/db/src/schema/`; do not grow one giant schema file. Domain state crosses the boundary as serialized, protocol-validated values, never as database rows. Consumers validate loaded snapshots with the protocol decoder before use.

`@offense-demo/db`'s `createDatabase()` composes one module per area (auth, email, outbox, and each product area you add — `*-operations.ts`, plus `outbox.ts`'s own `outboxOperations`), each taking only the opaque Drizzle handle and the event sink, never a raw table or transaction. Every operation reports failure through the package's one `instrumented(eventSink, operation, fn)` wrapper (`instrumented.ts`); the two `session.revoked` outbox appends (`appendSessionRevoked`, `revokeOtherSessions`) share one `appendSessionRevokedFor` (`session-revoked.ts`). Operations with no production consumer are not part of `createDatabase()`'s return value; `packages/db`'s own tests reach them through `test-only-operations.ts` or a direct submodule import, never through the public `@offense-demo/db` export.

## Conventions

- **Identifiers** are application-generated cuid2 values before writes (ADR 0018), shared across protocol/domain/persistence; PostgreSQL stores them as `text` and never generates them, and exactly one identifier shape is accepted anywhere (ADR 0023). A documented exception (a reference-data slug, for example) needs its own ADR.
- **Time**: `timestamptz` and UTC ISO strings; durations are integer milliseconds. `createdAt` is immutable; mutations explicitly update `updatedAt`. Times that decide outcomes are PostgreSQL time (`statement_timestamp()`), not the application clock.
- **Concurrency**: `version` begins at 1 on every concurrently mutated row; a save updates only the expected version and returns null on conflict. A retry re-reads current state and reruns domain rules — never blindly replay a stale snapshot.
- **Vocabularies**: every status column is `text` plus `CHECK`, and every CHECK vocabulary with a protocol counterpart is built from the protocol enum.
- **jsonb**: every jsonb column is a `jsonbColumn(name, schema)`: each write is parsed with the column's schema and a mismatch fails with an `AppError` `VALIDATION` before the driver sees it, and a `<table>_<column>_is_object` CHECK refuses a scalar or array written around the adapter (ADR 0038).
- **Indexes and timestamps**: every foreign key has a full index leading with its columns; every timestamp column is `timestampColumn` (timestamptz, Date mode).
- **Account deletion** tombstones the user: the row keeps its id, `deleted_at` is set and PII is scrubbed (`email`, `username`, `image` NULL, `name = ''`, enforced by CHECK); auth rows are deleted in the same transaction. Product records that reference the user keep the id and stay intact unless their own erasure rule says otherwise (ADR 0036).

## Transactions and idempotency

Compound operations belong in focused adapter functions sharing one transaction, not a generic repository wrapper. Concurrency-sensitive operations must document transaction boundary, duplicate delivery, retry budget, stable command/idempotency key, and conflict behavior. Unique application-minted ids prevent duplicate creation, but that is not complete idempotency (a duplicate may carry a different payload): full idempotency needs a durable key plus payload digest and result stored in the same transaction as the change.

Revoking all of a user's sessions is serialized against session creation in the database: `revokeOtherSessions` first takes the user row `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` lock every `session` insert's `user_id` foreign-key check holds until commit, and only then deletes, in a second statement whose Read Committed snapshot postdates the lock. An insert still uncommitted when the revoke starts is therefore waited for and deleted; one that starts later lands after the revoke. It is the only revoke-all: the email change and both self-service revoke-all endpoints use it, and so must every future one (recovery, ban). The email change's final step, `completeEmailChange`, moves the address and deletes the old address's outstanding sign-in links in one transaction. A magic-link sign-in that found the account before that switch but committed its session after the revoke-all is caught by `revokeSessionUnlessAddressHeld`, one statement run after the session commits that deletes it unless the account still holds the address the link proved.

## Tables the template ships

| Table                                                         | Owner         | Holds                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                                                       | identity      | The account: email, username, profile fields, `deleted_at` tombstone with the PII-scrub CHECK                                                                                                              |
| `session`, `account`, `verification`, `passkey`               | identity      | Better Auth's rows (ADR 0017); emailed-link tokens are stored as SHA3-256 digests only (ADR 0025)                                                                                                          |
| `email_delivery`, `email_delivery_event`, `email_suppression` | identity      | Auth mail diagnostics (ADR 0025): message and event ids, a monotonic status rank and a keyed SHA3-256 recipient hash only — never an address or a provider payload                                         |
| `outbox`                                                      | platform/data | Delivery log written in the same transaction as the change others must see: position `(txid xid8, seq)`, `topic`, `version`, `kind`, `payload` jsonb (doorbells on public topics), `created_at` (ADR 0032) |
| `seed_versions`                                               | platform/data | Which deterministic development seed a local database holds (`bun db:seed`)                                                                                                                                |

Product tables are added per project in forward migrations (`bun db:generate`), each in its own schema file, following the conventions above.

## Retention

The web server's one retention sweep (`apps/web/src/server/retention-sweep.ts`) deletes `email_delivery_event` rows 30 days after receipt, `email_delivery` rows 30 days after their last status change, expired `verification` rows after a 24 h grace, `outbox` rows 24 h after `created_at`, and lapsed presence members (ADR 0033). `email_suppression` rows are never pruned. Add every new table with a retention rule to the sweep and to the privacy inventory ([privacy](../operations/privacy.md)).

## Roles (ADR 0038, ADR 0041)

The single baseline creates the runtime roles. `offense_demo_web` is the web application's: DML on every `public` table and use of every sequence, and by default privileges on every table a later migration adds, but no schema changes, no `TRUNCATE` and no migration log. `offense_demo_realtime` gets only ADR 0032's explicit grants (SELECT on the outbox and the read models authorization needs) and writes nothing else. The browser suite's loopback login `offense_demo_e2e` is a member of `offense_demo_web` with no grant of its own, provisioned only by `provisionTestRoles` (`bun slot:up`, `bun db:reset`, `bun slot:reset-e2e`, CI's `bun db:roles`). Migrations run as the schema owner in a release-only app (ADR 0041).

## Redis

Redis is never authoritative for anything a cache loss would corrupt. Keys are `<deployment>:v1:<validated-segment>`; expiry is mandatory and set atomically with the value. Isolate deployments through namespace and credentials. Tests get unique namespaces (one logical database per slot, ADR 0034) and delete only their own keys. No global flush. Cache and presence loss must be recoverable from authoritative state.

- **Rate limits** are Redis-only (`<namespace>:v1:rl:<sha3-256>`, one atomic Lua `EVAL`, always expiring) with an explicit outage policy (ADR 0025); in-memory limiters are not multi-instance enforcement.
- **Connect tickets** for `apps/realtime` are single-use, short-lived keys (ADR 0031).
- **Presence** is Redis-only and advisory (ADR 0033). Each connection has a lease, `<namespace>:v1:presence:conn:<connId>`, a hash with its own TTL that the socket refreshes. Leases are indexed by per-user, per-room and online sorted sets scored by lease expiry from Redis `TIME`, each with its own expiry set in the same Lua script. Every write is one atomic Lua op, and every read is one Lua op that trims, ranges and hydrates. Durable decisions never read presence.
