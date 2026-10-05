# 0016: Injected clock and identity primitives

Status: accepted.

Shared application and domain code must not read wall-clock time or generate
identities implicitly. `@offense-demo/clock` owns the small contracts and edge
implementations needed to make those inputs explicit: `Clock` with `now()` and
`IdGenerator` with `next()`. Its system implementations use the runtime clock and the cuid2 generator
(ADR 0018); `fixedClock`, `sequentialId`, and `fixedIds` provide
deterministic implementations for tests and other callers that need
reproducible behavior.

The package public API is limited to `Clock`, `IdGenerator`, `systemClock`,
`systemId`, `fixedClock`, `sequentialId`, and `fixedIds` from its root export.
It has no runtime or workspace dependencies and may not depend on domain,
protocol, framework, persistence, logging, or other infrastructure packages. Consumers
receive the contracts through their owning operation or adapter; domain logic
remains pure and does not import runtime implementations.

This decision complements ADR 0003: injected time and identity are extraction
seams, not a general utility layer. New primitives or dependencies require a
separate architectural decision and an ownership-map update.
