# 0012: Native Bun infrastructure adapters

Status: accepted. Amended by [ADR 0038](0038-drizzle-1-baseline.md): Drizzle is pinned to the 1.0.0-rc.4 release candidate, on the owner's decision, to drop drizzle-kit 0.31's esbuild advisory; the no-RC rule below no longer applies to Drizzle.

We deploy Next's server with Bun, on a host/container that supports Bun rather than Node-only/Edge hosting. Drizzle 0.45.2 supports Bun SQL directly (confirmed against its tagged driver and migrator source). Use native pooled SQL with transaction, connection timeout, statement timeout and close semantics. This avoids a second PostgreSQL driver and makes Bun a real runtime decision. Native SQL cannot run under Node. If hosting changes, replace only this adapter, and rerun integration/concurrency/migration contracts. Never switch to an RC because the current docs installation snippet does so.

Use Bun RedisClient for the actual current needs: namespaced GET, atomic SET with expiry, DELETE and PING. Disable offline queue to avoid accumulating traffic during failure. Redis pub/sub is documented experimental and Sentinel/Cluster are unsupported, so neither is an implied supported deployment capability. Reassess before introducing distributed pub/sub or a cluster; a different driver may then be justified.

SQL and Redis connections are process-local resources, not process-local business state. Callers create one pool/client per server process and close them during shutdown. Health checks must be bounded at the delivery layer. Timeout wrappers bound waiting but do not cancel writes; PostgreSQL additionally enforces statement timeouts. Request cancellation must not be interpreted as proof that a mutation did not commit.

References: [Bun SQL](https://bun.sh/docs/runtime/sql), [stable Drizzle driver](https://github.com/drizzle-team/drizzle-orm/blob/0.45.2/drizzle-orm/src/bun-sql/driver.ts), [Bun Redis](https://bun.sh/docs/runtime/redis).
