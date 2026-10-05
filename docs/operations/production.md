# Production operations

## Process model

The production unit is `apps/web`: `bun run start` executes
`src/server/start.ts` (requires `NODE_ENV=production`), which opens its
port first behind a start-up gate (liveness answers 200, every other path 503) while it checks the runtime database role and prepares the Next build,
then serves requests over a custom HTTP server, and owns
lifecycle:

- **Draining**: a `draining` flag rejects new requests with 503 while
  in-flight requests finish (SIGTERM/SIGINT; 25s deadline, then forceful
  close). Load balancers should use readiness during deploys.
- **Timeouts**: request 30s, headers 15s, keep-alive 5s; database statements
  5s and locks 2s (adapter level); readiness probes bounded at 2s per
  dependency.
- **Shutdown order**: stop accepting → drain HTTP → close Next → finish
  auth work handed off past its answer → close database and
  Redis pools. The drain deadline is `SHUTDOWN_DRAIN_DEADLINE_MS` (25 s,
  `shutdown-budget.ts`); work it cuts off is logged as
  `auth.mail.abandoned`. fly.toml's `kill_timeout` (35 s) outlasts it, and
  `verify-deploy-config` fails when it does not. Connection pools are process-local resources;
  never shared across instances.

## Health and readiness

- `GET /api/health/live` — process aliveness only. Probe for restarts.
- `GET /api/health/ready` — 200 only when not draining AND PostgreSQL and
  Redis respond within bounds. Probe for traffic routing. Database
  availability is necessary, not sufficient: keep migration state and
  deployment gating in the release pipeline.

## Releases

1. Migrations run once per release as a pipeline step
   (`packages/db/scripts/migrate.ts` with the migration credential), never
   from every app instance, and before enabling dependent code
   (expand/contract for rolling deploys). The migrator's session gives up
   on a lock after 1 s and on a statement after 60 s, so hot-table DDL
   fails the release instead of stalling live traffic
   ([database operations](database.md)). On Fly the release is a
   separate, release-only migrator app ([ADR 0041](../decisions/0041-migration-credential-in-a-release-only-app.md)):
   Fly secrets are app-wide, reaching every machine of an app and its
   release command, so a `MIGRATION_DATABASE_URL` set on the web app would
   sit in every web machine's environment, not only the release command's. Reference data that the schema depends on ships
   inside the migration; `bun db:seed` is a development fixture (agent
   users and any domain fixtures) and never runs against production.
2. Provide `APP_VERSION`, `GIT_COMMIT`, `PUBLIC_APP_URL` (HTTPS),
   `DATABASE_URL` (the DML-only `offense_demo_web` role; startup refuses a role
   that can create or alter schema objects), `REDIS_URL`,
   `REDIS_NAMESPACE`, `LOG_LEVEL`. Never give the web app
   `MIGRATION_DATABASE_URL` (the schema owner): only the release migration
   holds it, and production web and realtime startup refuse to run with it
   in their environment. Configuration refinement fails startup on missing
   identity or insecure defaults — do not work around it.
3. Behind a reverse proxy, set `AUTH_TRUSTED_PROXIES` (IPs or CIDR ranges) to
   your own proxy's addresses: the ingress (`start.ts`) reads `Fly-Client-IP`
   directly past a trusted hop (Fly's own authoritative resolved value), or walks the `X-Forwarded-For` chain past those hops when that
   header is absent or unusable, and stamps the resolved address onto
   `x-offense-demo-client-ip`, the one header Better Auth trusts. Unset, no
   hop is trusted and every client behind the proxy shares one rate-limit
   bucket per auth path — safe, but coarse. Invalid proxy entries fail auth
   configuration by field name. Proxy validation is intentionally stricter
   than Better Auth's own, so that
   nothing accepted here is dropped at runtime: write IPv4 proxies in IPv4
   form (`10.0.0.0/8`), never as IPv4-mapped IPv6 (`::ffff:10.0.0.0/104`,
   which Better Auth would ignore), and without leading-zero prefixes.
4. Scale horizontally: the app is stateless except pools/logger/draining.
   Multi-instance safety relies on PostgreSQL for truth and Redis for
   coordination; sticky sessions are not part of any design.

## Realtime service

`apps/realtime` (`bun run start`, `NODE_ENV=production`) connects with
`DATABASE_URL` as `offense_demo_realtime`, the realtime service's only database
credential (ADR 0032 §7: `SELECT` on the delivery tables and nothing that
alters schema). It is never the migration owner and never `offense_demo_web`.
Before it subscribes to the outbox or accepts a socket, production startup
refuses a `DATABASE_URL` role that can create or alter objects in schema
`public` (`refuseSchemaAlteringRole` in `packages/db`, called by
`apps/realtime/src/serve.ts`), and refuses a
`MIGRATION_DATABASE_URL` in its environment. Set the
`offense_demo_realtime` password out of band, as for `offense_demo_web`. No realtime
deployment exists yet; when one is added it gets its own Fly app and
secrets, and never shares the migrator app's.

## Form actions and the public edge

Forms post to Next server actions (`docs/development/ui-conventions.md`).
Each action body is capped at 16 KiB before any action code runs. No action
calls `redirect()` when the page's script calls it: Next 16 would then fetch
the next page from the request's own public origin, through the edge, with
the browser's cookies forwarded. Actions answer those calls with
the destination instead, so the app makes no server-to-self request, and a
form posted without JavaScript gets a plain 303.

Whether the production edge accepts a server-to-self request carrying a
session cookie has not been checked: no production deploy exists yet, and
nothing relies on it. The browser suite's edge refuses it (its certificate
is self-signed), which is how the problem was found. If an action ever needs
`redirect()` on the scripted path, check the deployed edge first and record
the result here.

## Concurrency contract for mutations

Every durable mutation (any write other users can observe or race)
must state: transaction boundary, authorization principal, idempotency
semantics (stable command ID + durable key when duplicates are possible),
retry behavior, and conflict policy (optimistic version today; escalate to
pessimistic locking only with evidence of contention). See
`docs/architecture/persistence.md`.

## Security baseline

Secrets only via environment; never in client bundles (server-only config
is imported exclusively from server modules). CSP with per-request nonces:
the proxy generates the nonce and every route renders dynamically (root
layout awaits `connection()`), because statically prerendered pages are
built without the request nonce and would block all framework scripts —
e2e asserts nonce coverage so this pairing cannot silently regress.
`X-Frame-Options: DENY`, `nosniff`, strict referrer policy, HSTS in
production. Mutations require same-origin. Stable public errors never expose
internals; internal causes stay attached for in-process handling and are never
serialized to logs. Rate limiting must
be atomic server-side (Redis) before public mutations ship; in-memory
limiters are not multi-instance enforcement.
