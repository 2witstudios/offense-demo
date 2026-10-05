# ADR 0009: Portable versioned protocol contracts

Status: accepted.

`@offense-demo/protocol` defines the JSON contracts exchanged by browsers, realtime
servers, workers, replay processors, and future AI systems: Commands
(intent), Events (facts), Snapshots (serialized state), and stable public
Errors. Structures are versioned (`version` literals), JSON-compatible at
external boundaries, and validated with Zod at trust boundaries.

The protocol package imports nothing but Zod and error codes — no WebSockets,
no React, no database. Transports (HTTP and native WebSocket today) adapt to
the protocol, never the reverse. Snapshots are the persistence format for domain
state, so domain upgrades can restore old records through explicit version
migrations instead of depending on vendor storage formats.

Tradeoffs: explicit versioning and discriminated unions are more code than
ad-hoc payloads; that is the point — contracts outlive the code that produced
them and enable non-TypeScript consumers. Message evolution rules: additive
optional fields within a version; new version literals for breaking change;
never repurpose a field.

## Amendment (2026-09-22): socket and outbox schemas

With [ADR 0032](0032-transactional-outbox-delivery.md), `@offense-demo/protocol`
owns the WebSocket message schemas (client and server discriminated unions,
close codes, protocol version, topic grammar) and the outbox payload
schemas. They are Zod schemas like every other contract here, and every
receiver `safeParse`s them. The package still imports no WebSocket or
database code: the realtime service adapts to these contracts. Outbox
payloads on public topics are doorbells (ids, `kind`, `version`) only; see
ADR 0032's payload policy.
