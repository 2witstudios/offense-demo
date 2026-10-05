# ADR 0003: Modular monolith with extraction seams

Status: accepted.

This decision originally shipped one deployable application (`apps/web`)
over one database; `apps/realtime` is now a second deployment (see the
amendment below). Not a microservice fleet: distributed coordination would
consume the engineering budget the domain needs, and premature service
boundaries usually encode wrong guesses. Also not a single Next.js package:
framework delivery, domain, and infrastructure have different change
cadences and owners.

The monolith is modular in the strong sense: workspace packages with explicit
public APIs, an acyclic dependency graph, and mechanical enforcement.
Extraction seams are designed now (domain ↔ protocol JSON snapshots, db
adapter behind operations, Redis namespace discipline, injectable
clocks/IDs) so that a future realtime or worker service is a new
deployment of existing contracts, not a rewrite.

What we deliberately do not do: event sourcing, Kafka, Kubernetes, or a
message bus. Revisit each only with an ADR and an operational reason.

## Amendment (2026-09-22): outbox delivery

[ADR 0032](0032-transactional-outbox-delivery.md) adds a transactional
outbox so `apps/realtime` can deliver committed writes. It is a delivery log
inside PostgreSQL, not event sourcing and not a message bus: state still
lives in its tables and is never rebuilt from outbox rows, rows are pruned
after 24 h, and there is no broker, consumer group or second system. The
ban on event sourcing and a message bus stands. `apps/realtime` is the
"new deployment of existing contracts" this ADR anticipated.
