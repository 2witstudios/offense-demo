# Architecture overview

Modular monolith: `apps/web` (Next.js) and `apps/realtime` (native
`Bun.serve` WebSocket) are two deployments over one PostgreSQL database and
one Redis, with the product domain isolated in framework-free packages.
Boundaries exist so that workers, media services, AI agents — or
non-TypeScript services — can be extracted later without rewriting domain
contracts.

## Dependency direction

```text
apps/web (Next.js delivery, feature-local application operations)
    ↓
features (application operations: validation, principals, orchestration)
    ↓
@offense-demo/domain (pure product rules)
    ↓
@offense-demo/errors, @offense-demo/auth (inward-facing contracts)
    ↓
@offense-demo/protocol (portable versioned JSON; owns every shared vocabulary)
    ↓
@offense-demo/db (PostgreSQL adapter)   @offense-demo/redis (ephemeral adapter)
    ↓
@offense-demo/config  @offense-demo/clock  @offense-demo/logger  @offense-demo/observability  @offense-demo/typescript-config
```

Infrastructure adapters point inward. The domain never imports Next, React,
Drizzle, Bun SQL, Redis, or HTTP. Enforced mechanically by
`eslint.config.mjs` and `scripts/check-boundaries.ts` (declared dependencies,
the allowed-edge table in `scripts/boundaries-rules.ts`, acyclic graph,
explicit exports).

## Package map and ownership

| Package                      | Responsibility                                                                                                                                                                                                                                                                                                                                                                                        | May depend on                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `apps/web`                   | Delivery: routes, UI, health endpoints, process lifecycle, authentication composition (`features/auth` server factory mounted at `/api/auth` and `/auth/confirm`, `lib/auth-client.ts`, `lib/identity.ts` session-to-principal glue, `features/access` route guards, `features/account`, `server/authorize-request.ts` and the page read path `lib/request-route.ts`) — ADR 0017, ADR 0020, ADR 0048  | domain, protocol, auth, errors, config, clock, db, redis, logger, observability                                  |
| `apps/realtime`              | Realtime delivery, a second deployment (ADR 0031): socket authentication with first-message tickets, subscription authorization, outbox fan-out over native `Bun.serve` WebSocket, and presence (ADR 0033); no domain logic, media or jobs                                                                                                                                                            | protocol, auth, db (SELECT plus `service_instances` writes), redis, clock, config, errors, logger, observability |
| `packages/domain`            | The product domain: pure, deterministic operations over portable values (ADR 0005). The template ships a tiny placeholder; replace it with your rules                                                                                                                                                                                                                                                 | protocol, errors                                                                                                 |
| `packages/protocol`          | Portable versioned snapshots, messages and payloads; the one owner of every shared vocabulary (error codes, capabilities, resource kinds and deny reasons, realtime topic families, presence and delivery statuses)                                                                                                                                                                                   | zod                                                                                                              |
| `packages/db`                | Drizzle schema, migrations, transactional record adapters, the outbox, the authorization fact loader `loadAuthorizationContext` (ADR 0048); CHECK vocabularies derive from protocol enums                                                                                                                                                                                                             | config, errors, protocol                                                                                         |
| `packages/redis`             | Namespaced ephemeral key operations, presence leases, rate limits and lifecycle                                                                                                                                                                                                                                                                                                                       | config, errors, protocol                                                                                         |
| `packages/auth`              | Principal vocabulary, the username rule, `resolveIdentity` (verified session facts → anonymous / provisional / member principal), and the pure authorization evaluator `authorize` with `toAuthorizationInput` over the protocol's capability vocabulary; trusted authentication adapters plug in through an injected session reader; never imports Better Auth or any framework (ADR 0017, ADR 0048) | errors, protocol                                                                                                 |
| `packages/errors`            | The public/internal error mapping for the protocol's error codes; test support at `@offense-demo/errors/testing` (`assertRejects`, `rejectionOf`)                                                                                                                                                                                                                                                     | protocol                                                                                                         |
| `packages/config`            | Typed environment schemas: server, browser, and `requireTestServices` (the one integration-suite guard)                                                                                                                                                                                                                                                                                               | zod                                                                                                              |
| `packages/clock`             | Injected clock and identity primitives: `Clock`, `IdGenerator`, `systemClock`, `systemId`, `fixedClock`, `sequentialId` (ADR 0016)                                                                                                                                                                                                                                                                    | —                                                                                                                |
| `packages/logger`            | Structured logging facade over pino, admitting only allowlisted fields (ADR 0019)                                                                                                                                                                                                                                                                                                                     | pino; config (test only: secret keys for redaction tests)                                                        |
| `packages/observability`     | Spans, trace/request correlation, timeouts, the `ErrorReporter` port and `scrubEvent` (ADR 0037; no-op default, each app supplies its own vendor adapter)                                                                                                                                                                                                                                             | logger, `@opentelemetry/api`                                                                                     |
| `packages/typescript-config` | Shared strict tsconfig                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                |

Every path is owned by the repository owner named in `.github/CODEOWNERS`
until a second reviewer owns a package. New packages need: responsibility,
explicit `exports`, allowed dependencies, an owner, tests, and a row in this
table (`docs/development/extending.md`). The authoritative edge list is
`allowedWorkspaceDependencies` in `scripts/boundaries-rules.ts`; when this
table and that file disagree, the file wins and this table is fixed.

## State and runtime semantics

- **PostgreSQL** owns durable truth: users, sessions, credentials, the
  outbox, and every product record. Rows are persistence representations,
  never domain objects.
- **Redis** is expendable: presence, rate limits, connect tickets, caches.
  Keys are `<namespace>:v1:<validated-segment>` with mandatory expiry.
- **Process-local state** is limited to one composed app per process
  (connection pools, the logger, auth and the draining flag). Anything that
  must coordinate across instances lives in PostgreSQL or Redis. Never keep
  per-user or per-request data in a module-level variable: client modules
  also execute during server rendering, so such a variable is shared by
  every request on the server.
- **Composition root.** `createApp({ env, fetch, clock, ids })`
  (`apps/web/src/server/app.ts`) validates configuration and builds the
  logger, database, Redis, auth, rate limiter, mail and webhook for one app;
  `createRoutes(app)` builds every route handler from it. Route handlers and
  feature operations receive what they need as arguments. Exactly one module
  per app reads `process.env` or `globalThis`, its process edge:
  `apps/web/src/server/process-app.ts` keeps the process's app on
  `globalThis` (Next loads route modules, the proxy and instrumentation as
  bundles that share only that) and binds each `app/**/route.ts` export to
  it; `apps/realtime/src/start.ts` builds `createRealtimeApp`. Next renders
  pages and layouts itself, so server components cannot take arguments:
  they read this request's session through `lib/request-session.ts`, the one
  non-route module that takes the process app (`processApp().auth()`) and
  passes it on to `lib/identity.ts`. Only route bindings (`processRoute`),
  that module, `proxy.ts`, `instrumentation.ts` and `server/start.ts` may
  import the edge. ESLint enforces all of this, and tests build their own
  apps.
- **Domain state** is computed, not stored in memory between requests.
  Durable operations load the authoritative record from PostgreSQL, run a
  pure domain operation, and persist with an explicit concurrency policy
  (optimistic `version` by default).

## Realtime

`apps/realtime` delivers committed writes from the transactional outbox
(ADR 0032) to subscribers of four topic families, all keyed by cuid2 ids
and parsed only by `@offense-demo/protocol`'s `parseTopic`:

| Topic                 | Carries                                     |
| --------------------- | ------------------------------------------- |
| `room:<id>`           | Doorbells for changes to a room's records   |
| `room:<id>:presence`  | Who is in the room (Redis leases, ADR 0033) |
| `room:<id>:chat`      | Room chat messages                          |
| `user:<userId>:inbox` | Notifications for one user only             |

A "room" is the template's generic unit of shared live state; a project
maps it onto its own noun (a document, a match, a channel). Payloads on
public topics are doorbells (ids, kind, version), and clients refetch over
HTTP.

## Layering rules

1. Route handlers are transport: validate input, resolve the principal, call
   a feature operation, map errors. No domain rules in routes.
2. Feature operations (`apps/web/src/features/<name>/`) own orchestration:
   validation, authorization, domain calls, adapter calls, logging context.
   Authorization runs before any adapter access.
3. Domain invariants live in `@offense-demo/domain`; adapters never decide domain
   rules.
4. Shared UI only becomes shared when two real consumers exist.
5. Styling (`apps/web/src/ui/`, `apps/web/src/app/`) is token-locked Tailwind
   v4 (ADR 0028): utilities in the markup, a CSS-only theme that resets the
   default namespaces and maps only Offense Demo tokens, a build-time stylesheet
   only (no inline styles and no `unsafe-eval` under the strict nonce CSP),
   and lint, format and repository gates that fail on arbitrary values,
   unknown classes and `dark:` variants.
6. No admin screens or admin-only routes in `apps/web` (ADR 0043).

## Authorization core (ADR 0048)

- **One pure decision point.** `authorize` in `@offense-demo/auth` answers every
  read and create question from facts loaded fresh per request by
  `loadAuthorizationContext` in `@offense-demo/db`, mapped by
  `toAuthorizationInput`. Principals carry no permissions. `apps/web`
  composes the loader and the evaluator in `authorizeRequest(identity,
capability, resourceRef)` (`server/authorize-request.ts`); pages read
  through the same routes with `readRoute` (`lib/request-route.ts`).
  `authorizeSubscribe` will do the same for realtime topic families in
  `apps/realtime`'s subscribe decision, so neither app imports the other.
- **Vocabulary in the protocol.** Capabilities, resource kinds and deny
  reasons are `@offense-demo/protocol`'s. `@offense-demo/db` may not import `@offense-demo/auth`;
  it returns a plain projection that `@offense-demo/auth` maps.
- **Denied reads** answer `NOT_FOUND` for every principal; an unavailable
  identity answers 503 before any decision; a denial logs `authz.denied`
  with its `denyReason`.
- **Shipped:** `project.create` and `project.list` on the example
  aggregate. The service rule, `authorizeInbox` and the realtime
  composition land with their first consumer (ADR 0048, "What ships and
  what is deferred").

Detailed documents: persistence and Redis semantics
(`docs/architecture/persistence.md`), the documentation pipeline
(`docs/architecture/documentation-pipeline.md`), decision records
(`docs/decisions/`).
