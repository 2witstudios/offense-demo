# ADR 0010: Runtime validation at trust boundaries with Zod

Status: accepted.

Anything crossing a trust boundary is parsed, not assumed: environment
variables (`@offense-demo/config`), protocol payloads (`@offense-demo/protocol`), HTTP
input (`readJson` + feature schemas), serialized snapshots on restore. Zod 4
is the single validation library; its schemas double as the type source for
boundary payloads.

Boundaries are explicit and few: parse once where data enters, then trust
typed values internally — redundant per-function validation would add noise
without safety. Validation failures map to the stable `VALIDATION` public
error; internal causes are retained for logs, never echoed to clients.
Production configuration refinements refuse insecure defaults (HTTP URLs,
development credentials, deployment identity gaps) so misconfiguration fails
at startup, not at 3 a.m. in production.

Tradeoffs: schemas at boundaries are duplicated effort relative to "types
only" — we accept it because untrusted input is the primary attack surface,
and TypeScript types vanish at runtime.
