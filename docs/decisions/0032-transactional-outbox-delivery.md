# 0032: Transactional outbox delivery

Status: accepted (2026-09-22). Amends [ADR 0003](0003-modular-monolith.md),
[ADR 0008](0008-redis-ephemeral.md) and
[ADR 0009](0009-portable-protocol.md). Amended by
[ADR 0038](0038-drizzle-1-baseline.md): the realtime role and its grants
live in the single baseline, and web runtime access is the `offense_demo_web` role
it creates.

Adapted for the template from the project it was extracted from.

## Context

Offense Demo needs live delivery: room changes, presence, chat and notifications
reach browsers without a reload. ADR 0031 puts delivery in a separate `apps/realtime` service (native
WebSocket on `Bun.serve`) while `apps/web` stays the only writer: every
command arrives over HTTP and commits in PostgreSQL.

That leaves one question: how does a committed write reach every realtime
instance? PageSpace answered it with fire-and-forget HTTP broadcasts from
web to realtime, signed with one shared HMAC secret. Events were lost
whenever realtime was down, non-2xx responses counted as success, revocation
kicks were best effort, and the design only worked with one instance. We
design all of that out here.

## Decision

Every write that others must see appends an `outbox` row **in the same
transaction** as the write. Every realtime instance drains the outbox from
PostgreSQL in commit order and fans rows out to its own local sockets. The
database is the channel: there is no web-to-realtime HTTP call, no shared
secret, no message bus and no Redis pub/sub.

### 1. The outbox row and commit-ordered cursors

```sql
seq        bigserial   PRIMARY KEY,
txid       xid8        NOT NULL DEFAULT pg_current_xact_id(),
topic      text        NOT NULL,
kind       text        NOT NULL,
version    integer     NOT NULL,
payload    jsonb       NOT NULL,
created_at timestamptz NOT NULL DEFAULT statement_timestamp()
```

`created_at` is database time and drives the delivery-lag check and the
24 h prune (section 8). It never orders delivery; only `(txid, seq)` does.

`payload` is always a JSON object, enforced by
`CHECK (jsonb_typeof(payload) = 'object')`. Every runtime role that appends
to the outbox needs `INSERT` on `outbox` and `USAGE` on its `seq` sequence,
both granted in the migration that creates the table or the role.

The row's `version` column is the version of the entity the row announces
(what a client compares to detect a gap), not a fixed payload-schema
constant: it only ever increases, so `@offense-demo/protocol`'s payload schemas
(section 6) validate it as a positive integer, never the literal `1`. The
row's own `payload` carries this same value as `entityVersion`, a name no
schema version uses; there is no separate version on the `event` message.

A position is the pair `(txid, seq)`. A drain reads:

```sql
SELECT … FROM outbox
WHERE (txid, seq) > ($cursorTxid, $cursorSeq)
  AND txid < pg_snapshot_xmin(pg_current_snapshot())
ORDER BY txid, seq
LIMIT 500
```

**Why `seq` alone is wrong.** `bigserial` values are assigned when the row
is inserted, but transactions commit in a different order. Transaction A
inserts `seq = 101`, transaction B inserts `seq = 102`, and B commits first.
A reader that sees 102 and advances its cursor to `seq > 102` never reads
101 when A commits a moment later. The row is skipped permanently, and
nothing downstream can tell.

**Why the `txid` filter is right.** `pg_current_xact_id()` returns the
writing transaction's 64-bit `xid8` id, assigning one if needed; `xid8`
values increase strictly monotonically and are never reused.
`pg_snapshot_xmin(pg_current_snapshot())` is the lowest transaction id
still active; every id below it is finished for everyone, either committed
and visible or rolled back and gone ([PostgreSQL 17, §9.27 system
information functions](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-PG-SNAPSHOT);
[§8.19 `xid8`](https://www.postgresql.org/docs/17/datatype-oid.html)).
A drain therefore only reads rows whose transaction can no longer change,
and it reads them in `(txid, seq)` order. Any row that becomes readable
later belongs to a transaction that was still active at the previous drain,
so its `txid` is at or above that drain's `xmin`, which is above every
position already read. The cursor only moves forward and never passes an
unread row. In the example, neither 101 nor 102 is read until A and B have
both finished, and then both are read.

A rolled-back transaction's rows never exist for any reader, so a
rolled-back write is never delivered.

The cost is latency, not correctness. `pg_snapshot_xmin` is held back by
**any** transaction that holds an xid anywhere in the PostgreSQL cluster,
whether or not it touches the outbox and whatever database it runs in, so a
shared cluster counts too. A committed row stays unreadable until every
older xid-holding transaction in the cluster has finished. A long migration
backfill or a large prune `DELETE` therefore stalls all delivery. So the
maintenance sweep's prunes and any backfill run in short batches, each its
own short transaction.

Clients receive a position as an opaque cursor string. It is an ordering
token, not a secret; the server validates its shape on every use and never
trusts it for authorization.

### 2. Instance startup order

1. `LISTEN outbox` on the dedicated listen connection, and wait for the
   acknowledgement.
2. Read the high-water mark: the greatest `(txid, seq)` whose `txid` is
   below `pg_snapshot_xmin(pg_current_snapshot())`. Set the instance cursor
   to it. Instances hold no history; clients bring their own cursors.
3. Only then accept sockets.

LISTEN comes first so that no commit can fall between the high-water read
and the subscription without producing a wakeup. Sockets come last because
subscribe catch-up (section 4) reads up to the instance cursor, which must
exist first. A process restart repeats all three steps; nothing lives only in
process memory.

### 3. Delivery: the poll is the correctness mechanism

- A single drain loop per instance, never concurrent with itself, reads
  ordered ranges of up to 500 rows until a range comes back short, then fans
  each row out to the local sockets subscribed to its topic. For each range,
  advancing the instance cursor, appending the rows to the ring and
  publishing them happen in one synchronous tick, with no `await` in
  between (section 4 depends on it). That is one
  range query per wakeup per instance, never one query per event.
- **The drain runs every 1 s, whatever else happens.** That poll is what
  makes delivery correct: every committed row is read within one period
  after every older xid-holding transaction in the cluster has finished.
- **NOTIFY only lowers latency.** The append operation calls
  `pg_notify('outbox', position)` in the writing transaction. PostgreSQL
  delivers notifications only when that transaction commits and discards
  them if it rolls back
  ([PostgreSQL 17, `NOTIFY`](https://www.postgresql.org/docs/17/sql-notify.html)),
  so a notification can never announce a rolled-back write. On receipt, an
  instance only sets a `dirty` flag, with the payload as a hint that data
  exists up to at least that position, and the drain loop runs at once
  instead of at the next tick.
- **When `dirty` is cleared and re-armed.** The drain loop clears `dirty`
  before each pass, not after it. A NOTIFY that arrives during a pass sets
  it again, and the loop runs another pass as soon as the current one ends.
  A NOTIFY for a row that is not final yet (an older xid is still active)
  is picked up by the next 1 s tick at the latest.
- NOTIFY is lossy by design here: PostgreSQL delivers only to connected
  listeners, and a notification sent while the listen connection is down is
  gone. Nothing depends on it, because the drain reads from the cursor, not
  from notifications.
- PostgreSQL holds sent notifications in a shared queue until every
  listener has read them, and a full queue makes `NOTIFY` fail at commit.
  The listen connection therefore never holds a transaction open: Bun
  dedicates it to subscriptions, and Offense Demo runs no queries on it.
- The poll is not a fallback and must never be described or coded as one.
  There is one delivery path, the drain; NOTIFY is a trigger for running it
  sooner. If NOTIFY's commit-time cost ever matters under contention, LISTEN
  and `pg_notify` are removed outright and the drain keeps its 1 s period.
  No code shape changes, no mode flag exists, and nothing is "kept for now".
- **LISTEN reconnect.** When the listen connection drops and returns, the
  drain runs from the in-memory instance cursor (Bun's `onlisten` callback,
  below).
- When an instance lease table exists, each realtime instance reports its
  cursor there as `deliveredThrough`, which is how delivery lag is
  measured. The template does not ship that table yet.

**Bun 1.4.2 support, verified against the installed documentation**
(`bun-types@1.4.2`: `sql.d.ts` and `docs/runtime/sql.mdx`, section
"LISTEN / NOTIFY (PostgreSQL)"):

- `sql.listen(channel, onnotify, onlisten?)` resolves once PostgreSQL has
  acknowledged the `LISTEN`, so a notification issued after it resolves is
  delivered. It returns a `ListenSubscription` with `unlisten()` that is
  also an async disposable.
- All subscriptions on one client share one dedicated connection, opened by
  the first `listen()` and closed with the last `unlisten()`.
- If that connection drops, Bun reconnects with exponential backoff (250 ms
  doubling to 32 s, with jitter) and re-subscribes every channel.
  Notifications sent in between are lost. `onlisten` runs on the initial
  subscribe and again after every reconnect, and the documentation names it
  as the place to catch up.
- `sql.notify(channel, payload?)` runs `SELECT pg_notify($1, $2)` on the
  handle it is called through. Inside `sql.begin()` it is delivered on
  commit and dropped on rollback.
- Channel names are quoted by Bun and limited to 63 bytes; payloads are
  limited to 8000 bytes by PostgreSQL's default. A throwing `onnotify` or
  `onlisten` is reported as an uncaught exception and stays subscribed, so
  both callbacks only set flags or schedule the drain.
- LISTEN/NOTIFY is PostgreSQL-only in Bun SQL; on MySQL and SQLite these
  methods reject. Offense Demo uses only PostgreSQL.

LISTEN is therefore available in the pinned Bun version, and the design uses
it as specified above.

### 4. Client catch-up

`subscribe {topic, since}` on an authorized topic runs in one order:

1. Authorize the topic (the subscribe registry of the realtime service ADR).
2. Record `C`, the instance cursor when the catch-up query starts.
3. Read that topic's rows from PostgreSQL with positions after `since` and
   at or before `C`, and send them.
4. In the same synchronous tick, call `ws.subscribe(topic)` and replay the
   rows for that topic from the drain loop's ring of recently fanned-out
   rows whose positions are after `C`.
5. Reply `subscribed`.

Native Bun topics publish straight to subscribed sockets, so the drain loop
cannot buffer per socket. The ring replaces that buffer: JavaScript runs one
task at a time, so no drain can fan out a row between step 4's replay and
its subscribe. Rows at or before `C` come from PostgreSQL, rows after `C`
come from the ring or, after the subscribe, from live fan-out. There is no
gap and no duplicate; clients also de-duplicate by position.

This relies on one invariant of the drain loop: **advancing the instance
cursor, appending to the ring and publishing happen in one synchronous
tick.** If the cursor moved before the publish with an `await` in between, a
subscribe could record a `C` that covers rows that were neither sent nor in
the ring yet. The drain loop never awaits between these three steps, and its
tests must prove that a subscribe racing the drain misses nothing.

The server replies `resync_required` instead when:

- `since` is older than retention, or more than N rows behind;
- the ring no longer reaches back to `C`.

The client then refetches the snapshot or version over HTTP and subscribes
from the current position.

### 5. Revocation writers

Revocations are outbox rows, so every instance applies them durably. They
are not best-effort HTTP.

- **`session.revoked`** has two kinds of writer, split by whether a
  Offense Demo-owned transaction wraps the delete:
  - The browser calls Better Auth's `/revoke-session` directly; no Offense Demo-owned transaction wraps that internal delete. The writer is a
    Better Auth plugin registering `hooks.after` on it
    (`apps/web/src/features/auth/session-revoked-outbox.ts`). The append is
    **best-effort**, appended **after** the delete is confirmed, in its own
    short transaction, never in the same transaction as the delete. A
    failed append is logged as a registered structured event and never
    fails the revocation, whose session delete has already committed. The
    realtime service's 60 s session revalidation is the safety net, so the
    kick is late by at most 60 s, never missed.
  - Every revoke-all deletes through `@offense-demo/db`'s `revokeOtherSessions`,
    Offense Demo's one serialized revoke-all: the email-change completion and the
    self-service `/revoke-other-sessions` and
    `/revoke-sessions`, which `revoke-sessions.ts` replaces under Better
    Auth's own paths. It locks the user row, then deletes in one statement,
    so a session committed while it runs cannot survive it
    ([persistence](../architecture/persistence.md)). Because Offense Demo owns the
    transaction here, the append happens in the **same transaction** as that
    DELETE: a failed append rolls the DELETE back too. The email change
    reports the cleanup step failed; the self-service endpoints report the
    outage, so the person retries rather than believing they signed out
    other devices. These are the `session.revoked` writers that are atomic
    with their delete.

- **`access.revoked`** (`ids: [userId, roomId]`) is appended by the
  membership and visibility mutations that take a user's access to a room
  away: leaving, removal, and a room becoming private. The row is written
  in the mutation's own transaction. The template defines the payload; the
  first product mutation that revokes room access adds the writer.
- **Better Auth's other internal session deletes** (expiry, sign-out and
  any path that does not pass through these writers) append nothing. They are
  bounded by the realtime service's 60 s session revalidation: a socket on a
  deleted session is closed at the next revalidation at the latest.

On `session.revoked` an instance closes the matching sockets with the
revoked close code; on `access.revoked` it unsubscribes the user from the
room's topics.

### 6. Payload policy

- **Public topics carried through the outbox** (`room:<id>`) carry doorbells
  only: ids, `kind` and `entityVersion`. Never user content, names or text.
  `room:<id>:presence` carries no outbox payload at all: presence is never
  written to the outbox (ADR 0033 §1) and is delivered instead as the
  `presence.changed` server message (ADR 0031 §6), which names no `kind`
  and carries no `entityVersion`. `room:<id>:chat` carries nothing through
  the outbox until a chat feature defines its kinds.
- **Owner-only topics** (`user:<userId>:inbox`) may carry small typed
  deltas, since only the owner can subscribe.
- The doorbell kind names, exactly (`@offense-demo/protocol`'s outbox payload
  schema, `realtime-payloads.ts`): `room.changed` (the `room:<id>` family).
  The owner-only inbox delta kind is `user.notification-delivered` (the
  `user:<userId>:inbox` family; notification content is left to the
  product).
- **Control rows ride the user's own inbox.** `session.revoked` (section 5),
  `access.revoked` (section 5) and `user.presence-preference-changed` (a
  visibility preference change, appended in the settings transaction) are
  outbox rows on `user:<userId>:inbox`, never rows without a topic.
  `@offense-demo/protocol`'s storage rule (`isPayloadStorableOnTopic`), which
  `@offense-demo/db`'s append validates against before insert, allows these three
  control kinds on `user:inbox`; the delivery rule the `event` message
  enforces, added with the first `event` sender, never allows them
  anywhere. Realtime consumes the three control kinds straight from its own
  drain of the inbox topic — closing revoked sockets, unsubscribing a
  revoked user, and re-projecting that user's presence locally and ringing
  `presence.changed` — and never forwards them to any client as an `event`.
- Clients refetch over HTTP, where permissions are enforced on every read.
  So a subscriber who lost access and is still inside the 60 s
  re-authorization window learns at most that something changed.
- Payloads are Zod schemas in `@offense-demo/protocol` and every receiver
  `safeParse`s them (ADR 0009 as amended).

### 7. The realtime database role

`apps/realtime` connects as its own PostgreSQL role (`offense_demo_realtime`, created
in the baseline migration) with exactly these grants:

- `SELECT` on `outbox`;
- column-scoped `SELECT` on Better Auth's `session` table (`id`, `user_id`,
  `expires_at`). Revalidation reads `session` directly. The role can never
  read `token`, `email`, `name`, `image` or any other column of `users` or
  `session`;
- `SELECT` on the read models the subscribe decision needs (rooms and
  memberships, presence visibility), each granted — column-scoped where the
  table holds personal data — in the migration that creates the table. A
  new table stays invisible to realtime until a migration grants it;
- `INSERT` and `UPDATE` on an instance lease table, if one is ever added,
  for its lease and `deliveredThrough`.

Nothing else: no `INSERT` on `outbox` and no `USAGE` on its sequence, no
`DELETE` or `TRUNCATE` anywhere, no writes to any other table. Realtime
cannot fabricate or erase a delivery. `apps/web` stays the only writer of
durable state and the only appender to the outbox.

**Sequence USAGE.** A `serial`/`bigserial` column's `nextval()` default
needs sequence `USAGE`, which a table-only grant pattern does not cover.
Every runtime role that appends to the outbox gets it in the same baseline
migration that grants its table access: the migration owner has it
implicitly through table ownership, and the web runtime role (`offense_demo_web`,
ADR 0038) is granted `USAGE` on the schema's sequences, present and future.

### 8. Retention

The maintenance sweep prunes outbox rows whose `created_at` is older than
24 h, in short batches
(section 1). A client whose
`since` falls before the retained range gets `resync_required` and reloads
over HTTP; nothing correct depends on an outbox row older than that.

### 9. A delivery log, not event sourcing or a message bus

ADR 0003 rules out event sourcing and a message bus. This design is neither.

- **Not event sourcing.** Durable state lives in its tables and is written
  by the same commands as before. Outbox rows are notifications derived
  from those writes, written alongside them; state is never rebuilt by
  replaying them, and pruning the whole outbox loses no durable truth. A consumer that misses too much reloads state, not events.
- **Not a message bus.** There is no broker, no second system, no consumer
  groups, acknowledgements or redelivery. It is one table in the PostgreSQL
  that is already the source of truth (ADR 0007), read with an ordinary
  query. The single dependency is the database every service already needs.

## Consequences

- Delivery survives realtime restarts and outages: clients reconnect and
  catch up from their cursor.
- Multi-instance works with no adapter, no Redis pub/sub and no second Redis
  client; each instance drains independently.
- No web-to-realtime secret exists, so there is nothing to sign, rotate,
  replay or lose.
- Each instance issues at least one range query per second; that cost is
  bounded and independent of traffic.
- Any long-running xid-holding transaction in the cluster delays delivery
  of every later row until it finishes, and the outbox-lag health check
  reports it. Prunes and backfills therefore run in short batches.
- The baseline creates the outbox and the realtime role; the drain loop,
  ring and subscribe catch-up are built in `apps/realtime` against this
  record.
