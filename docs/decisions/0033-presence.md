# 0033: Presence

Status: accepted. Extends [ADR 0008](0008-redis-ephemeral.md) (presence is
Redis state) and [ADR 0016](0016-injected-clock-and-identity.md) (time is an
input). ADR 0031 (the realtime service) and ADR 0032 (the outbox) decide the
transport and delivery this ADR builds on.

Adapted for the template from the project it was extracted from. The product-specific
sections (durable attendance, deadlines and their adjudication) were
removed; their numbers stay absent so that code citing §1, §3 and §6 still
resolves.

## Context

Live features need **social presence**: who is online, away or in a room,
and how many people are there. It is advisory, lossy and cheap to be wrong
about, and it must never be confused with durable state. Anything a product
decides from "was this person there" comes from durable PostgreSQL rows
written by HTTP commands, never from presence.

The rules this record designs for: a disconnect is never treated as a
durable fact, nothing flaky may decide an outcome, and a user may be
invisible.

## Decision

### 1. Social presence is advisory and lives in Redis leases

1. **One lease per connection, never one field per user.** Each socket owns
   a lease the realtime instance holding it creates on `hello`, refreshes
   every 20 s with a 60 s TTL, and deletes on a clean close. The connection
   id is a cuid2 the instance mints; it is an identifier, never a secret,
   and never leaves the server. Every key follows the persistence
   convention:
   - `<namespace>:v1:presence:conn:<connId>`: hash
     `{userId, activity, instanceId}` with its own TTL.
   - a per-user sorted set of `connId` scored by lease expiry.
   - `<namespace>:v1:presence:online`: sorted set of `userId` scored by the
     user's latest lease expiry.

   Every create, refresh and delete is one atomic Lua op in `@offense-demo/redis`.
   Every lease score and trim uses Redis `TIME` inside the script, so one
   clock governs hash TTLs and sorted-set scores and no instance clock is
   ever compared with another. The per-user and online sorted sets carry
   their own mandatory expiry, set in the same script to at least the
   longest live lease. Every read is one bounded, read-only Lua op that
   filters out members whose score is in the past, ranges and hydrates, and
   returns the Redis `now` it used (lapsed members are trimmed by writes
   and the retention sweep, never by a read; see the amendment below), so a
   caller deriving presence never substitutes an instance clock for it.
   When an instance crashes, each of its leases expires on its own; a stale
   lease can never outlive its TTL and poison a result.

2. **Activity and visibility are separate axes.**
   - `activity: active | idle` belongs to a connection. The client reports
     it with `presence.activity`: `idle` when the tab is hidden or there has
     been no input for 5 minutes, otherwise `active`.
   - `visibility: visible | invisible` belongs to the account. It is a
     durable privacy preference in PostgreSQL, written only by the settings
     operation. It is never written to a Redis field, and no code treats
     `invisible` as `idle` or `idle` as `invisible`.
   - Being in a room comes from PostgreSQL membership rows, never from the
     client.

3. **Status is derived in two pure steps.**
   - A derivation over `{ leases, memberships }` and `nowMs` returns the
     internal state: `connected` (at least one unexpired lease), `activity`
     (`active` if any unexpired lease is active, otherwise `idle`) and the
     rooms the user is in. It knows nothing about privacy.
   - A projection over that state, the user's visibility and the viewer
     returns the public status from `@offense-demo/protocol`'s `presenceStatuses`
     (`in-room | online | away | offline`). An invisible user is `offline`
     to everyone but themself. For a visible user the order is `in-room`,
     then `online` (active), then `away` (idle), then `offline`.
   - Aggregate counts (online users, people in a room) count only projected
     visible users, so invisible users are excluded from every count.
   - No projected value or broadcast ever carries a connection id, an
     instance id or another user's activity detail beyond the status.
   - Both steps are pure functions shared by `apps/web` and `apps/realtime`.
     They live with their first consumer and move to a shared package only
     when the second consumer lands (the two-consumer rule in AGENTS.md).

4. **Doorbells fire on the projected value, and realtime writes nothing.**
   Presence is not in the outbox. Each realtime instance, once per second,
   takes the `room:<id>:presence` topics it has local subscribers on and
   does two reads for all of them together: one Redis Lua read of their
   leases, and one PostgreSQL read of the memberships and visibility of the
   users involved. For each topic it derives and projects as a viewer who
   is not the user, together with the visible counts, and publishes
   `presence.changed` to its own sockets only when that projected value
   changes. Because the trigger is the projection, an invisible user
   connecting, idling or leaving rings no doorbell, so nobody can learn
   their activity from timing. Clients refetch the projected value over
   HTTP from `apps/web`. Every instance reads the same Redis and
   PostgreSQL, so no cross-instance message exists, and the realtime role
   stays read-only. The one presence change `apps/web` writes is a
   preference change: it appends the control kind
   `user.presence-preference-changed` on the user's own
   `user:<userId>:inbox` in the settings transaction; realtime consumes it
   from the drain to re-project that user's presence locally and ring
   `presence.changed`, never as an outbox doorbell delivered on a
   subscribed topic (ADR 0032 §6).

The Redis lease operations and the protocol vocabulary are implemented
(`packages/redis/src/presence*.ts`, `packages/protocol/src/realtime.ts`);
the derivation, projection and the 1 s doorbell loop are decided here and
are built with the subscribe registry (ADR 0031 §5).

### 2. (Removed: product-specific; intentionally absent in the template.)

### 3. One clock: PostgreSQL time for durable facts

1. **Durable times are database receipt times.** When a product records
   when something happened (a join, a submission, a status change), the
   time is the `statement_timestamp()` of the writing transaction, taken
   before any row lock is requested, so waiting on a lock never makes a
   write late. Not the client's clock and not the web instance's clock.
2. **Every durable time uses the same clock.** Write paths stamp
   `started_at`, `joined_at`, `completed_at` and similar columns with the
   `statement_timestamp()` of that write, never a caller-supplied value,
   and readers use that column, never a snapshot or client value. Domain
   code receives these values as explicit inputs (UTC ISO strings, integer
   millisecond durations) and stays pure (ADR 0016).

### 4. (Removed: product-specific; intentionally absent in the template.)

### 5. (Removed: product-specific; intentionally absent in the template.)

### 6. The reconnect allowance

A dropped socket is not an absence. Any window a product gives a user to
act after losing their connection must cover:

```text
graceMs >= heartbeatMs * 2 + reconnectBudgetMs
```

`heartbeatMs` (15 000, ADR 0031 §7) is an `@offense-demo/protocol` constant, and
`reconnectBudgetMs` (10 000) joins it there with its first consumer, so
both sides read one value; the floor is therefore 40 000 ms.
`reconnectBudgetMs` is a nominal allowance, not a bound ADR 0031's backoff
enforces: the backoff has no cap and `rate_limited` waits at least 30 s.
Because commands go over HTTP whatever the socket does, the term only sizes
the grace window. A product that adds such a window enforces the inequality
as a domain invariant in `@offense-demo/domain`, registered with `bun invariants`.

### 7. (Removed: product-specific; intentionally absent in the template.)

### 8. (Removed: product-specific; intentionally absent in the template.)

### 9. (Removed: product-specific; intentionally absent in the template.)

### 10. (Removed: product-specific; intentionally absent in the template.)

### 11. (Removed: product-specific; intentionally absent in the template.)

## Consequences

- Presence can be wrong for up to a lease TTL after a crash, and that is
  acceptable because nothing durable reads it.
- A realtime instance's presence re-derivation costs one Redis Lua read and
  one PostgreSQL read per second. Each read covers all of the instance's
  subscribed presence topics together, and the subscription cap per socket
  bounds the work.
- Presence visibility, when a product adds it, is a durable personal-data
  column classified under ADR 0036.

## Amendment (2026-09-23): single-node Redis, bounded reads, EVALSHA

A repository audit found the presence Lua scripts building connection-hash
key names inside the script (`ARGV[2] .. connId`, in the per-user
connections read) rather than declaring every key through `KEYS`, and asked
to either fix that or document why not.

**Decision: keep the design, on ADR 0008's existing single-node assumption.**
ADR 0008 already settles this — "no Sentinel/Cluster support in the native
client" — and `@offense-demo/redis`'s README says the same. `KEYS` only has to
enumerate every key up front for Redis Cluster's client-side slot routing;
on one node, a script may address any key it can name, computed or not, and
Lua's own `redis.call` never cares which array it came from. A per-user
connections read cannot size its `KEYS` array ahead of time anyway (it does
not know how many live connections a user has until it ranges the zset), so
passing every hash key through `KEYS` here would mean a client round trip to
range the zset before the read, which reintroduces exactly the
non-atomicity (a lease could upsert or delete between the two calls) the
one-op read design exists to avoid. If a Cluster deployment is ever
adopted, that is its own ADR (per ADR 0008) and this script is redesigned
around hash tags then, not defended in place.

**`readOnlinePresence` takes a mandatory `limit` and never trims on read.**
The `online` key is a single global sorted set every user sits in, so an
unbounded read scales with total users ever online, not with what a caller
actually needs; a read that also `ZREMRANGEBYSCORE`d gave every reader a
side effect on shared state. The read is a bounded, read-only
`ZRANGEBYSCORE ... LIMIT`, filtering expired members by score without
deleting them. `sweepOnlinePresence(limit)` does the bounded trimming
instead, run on its own schedule, not implied by a read.

**Every presence read is bounded and read-only, and the online sweep has an
owner.**

- The per-user connections read ranges at most 32 live connections
  (`ACTOR_CONNECTIONS_MAX` in the code), latest expiry first
  (`ZREVRANGEBYSCORE ... LIMIT`), and does not trim. The upsert and refresh
  scripts trim the per-user zset's lapsed members on the write path, and
  the delete script already did, so a reconnecting user's zset stays small
  without a read ever writing.
- Every presence `limit` is capped at `PRESENCE_LIMIT_MAX` (1000).
  `sweepOnlinePresence` hands every expired member to one `ZREM` through
  Lua's `unpack`, which fails past roughly 8,000 values ("too many results
  to unpack", nothing removed); the cap keeps every accepted limit far
  below that.
- **Owner and schedule:** the web server's one retention sweep
  (`apps/web/src/server/retention-sweep.ts`, target
  `retention.presence_online`) runs `sweepOnlinePresence` at start-up and
  then hourly, up to 50 batches of 1000 per run, in the same process and
  schedule that prunes the PostgreSQL retention tables. Every instance runs
  it; the sweep is one atomic Lua op, so concurrent runs cannot
  double-remove. Redis stays expendable: a failed Redis batch logs
  `retention.sweep.failed` and leaves lapsed members, which reads already
  filter by score, for the next run; nothing durable reads them.

**Every presence script loads once and runs by `EVALSHA`.** Each script is
`SCRIPT LOAD`ed the first time `createPresenceOperations` uses it and cached
by its source; every call after that sends only the SHA1 and arguments,
reloading and retrying exactly once on `NOSCRIPT` (e.g. after a restart or
`SCRIPT FLUSH`).

**`activity` and `userId` are parsed with `@offense-demo/protocol` schemas.**
`presenceActivitySchema` replaces a hand-rolled check, on both the write
path and when hydrating a read. `userId` is parsed with `idSchema` (cuid2)
rather than the generic Redis-key-segment shape, since it is a domain
identifier, not an arbitrary safe string; `connId` and `instanceId` stay on
the generic key-segment check, since they are server-minted labels rather
than domain ids. `packages/redis` may depend on `@offense-demo/protocol`
(`scripts/boundaries-rules.ts`, `docs/architecture/overview.md`) for
exactly this: it reuses the vocabulary the socket protocol already owns
instead of maintaining a second, looser copy of it.
