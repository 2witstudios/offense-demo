# ADR 0008: Redis as expendable coordination infrastructure

Status: accepted.

Redis holds only ephemeral or reconstructible state: presence, work
queues, rate-limit counters, ephemeral room state, caches. Expiry is
mandatory and set atomically with the value. Nothing that must survive a
cache loss lives here; if a Redis outage would corrupt durable records,
that data is in the wrong place.

We use Bun's native `RedisClient` rather than adding `redis`/`ioredis`: our
current needs are namespaced GET/SET-EX/DEL/PING, the native client covers
them, and one fewer client removes a dependency lifecycle. Offline queue is
disabled so failures surface immediately instead of silently buffering.
Keys are `<namespace>:v1:<validated-segment>`; deployments isolate through
namespace plus credentials.

Constraints documented up front: no Sentinel/Cluster support in the native
client, pub/sub is upstream-experimental. If we need distributed pub/sub or a
cluster, that is a new ADR with a possibly different driver.

## Amendment (2026-09-22): no Redis pub/sub for delivery

[ADR 0032](0032-transactional-outbox-delivery.md) delivers live events
through a transactional outbox in PostgreSQL that every realtime instance
drains, so multi-instance fan-out needs no Redis pub/sub, no pub/sub adapter
and no second Redis client. Redis keeps its role here: presence leases,
single-use connect tickets and rate limits, all expendable and expiring.
Adopting Redis pub/sub still requires a new ADR.
