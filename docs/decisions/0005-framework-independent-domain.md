# ADR 0005: Framework-independent domain

Status: accepted. Amended by [ADR 0018](0018-cuid2-identifiers.md) and
[ADR 0023](0023-greenfield-baseline.md): marshalled identifiers are cuid2, not
UUIDs; the text below states the current rule.

Adapted for the template from the project it was extracted from.

The product domain lives in `@offense-demo/domain` (`packages/domain`): no Next,
React, Bun APIs, Drizzle, Redis, HTTP, or ambient clocks. Operations are
synchronous and deterministic pure functions; IDs and timestamps arrive as
arguments; serialized state is portable JSON defined by `@offense-demo/protocol`.
The template ships a deliberately tiny placeholder domain; a new project
replaces it with its own rules while keeping these constraints.

Why: the domain is the part of the product most likely to outlive any
framework, to be extracted into a separate service, and to be exercised by
AI systems that must not boot a web server to reason about it. Determinism
also makes invariants testable in milliseconds without infrastructure.

Tradeoffs: application code must marshal inputs (cuid2 ids, ISO timestamps,
validated snapshots) across the boundary. Durable flows follow the
load → operate → persist pattern with optimistic version checks; the domain
never talks to the database itself. `eslint.config.mjs` and
`scripts/check-boundaries.ts` enforce the purity rules mechanically.
