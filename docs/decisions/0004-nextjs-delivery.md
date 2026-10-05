# ADR 0004: Next.js as the application delivery layer

Status: accepted.

Next.js (App Router) delivers the web application: routing, rendering,
server operations, and process hosting for the HTTP surface. It is a delivery
concern, not the architecture: domain, protocol, and adapters do not import
Next or React, so a future realtime server or worker shares the domain
without a web framework.

We follow Next's current guidance for AI agents: read the version-matched
docs shipped in `apps/web/node_modules/next/dist/docs/` before writing
Next-specific code; never trust remembered APIs (examples: middleware is now
`proxy.ts`; `NODE_ENV` is typed read-only; route params are promises).
Production runs through `src/server/start.ts`: a custom server providing
graceful shutdown, draining, bounded timeouts, and validated configuration —
the pieces a bare `next start` does not give us.

Tradeoffs: a custom server takes responsibility Next's platform would
otherwise own; we accept that for explicit lifecycle control and because it
is the seam where extraction later happens. Security headers, CSP nonces, and
request correlation are established at the proxy/edge layer.
