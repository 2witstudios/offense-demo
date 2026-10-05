# 0037: Error tracking and product analytics

Status: accepted. Amends [ADR 0015](0015-event-stream-as-observability-source-of-truth.md)
(the event stream stays the operational source of truth; a vendor adapter
never replaces it) and the "vendors belong to deployment" line of
[observability.md](../operations/observability.md), which until now read
that adding a vendor SDK requires an ADR without saying which vendors or
under what constraints. Applies the classification of
[ADR 0036](0036-privacy-by-design.md) to the Sentry and PostHog surfaces.

Adapted for the template from the project it was extracted from.

## Context

Offense Demo has no error tracker and no product analytics. Owner decision
(2026-09-22): build both vendor seams and both adapters now — Sentry for
error tracking, PostHog for product analytics — rather than defer them
again once features are shipping. US-first, GDPR-ready: the full set of
controls ships now, and only the vendor region is a deploy-time setting.
Both adapters must stay inert until their environment keys are set, so a
checkout with no keys makes no vendor network call and boots identically
to today.

## Decision

### Error tracking (Sentry)

- The `ErrorReporter` port, `capture(error, { requestId, route, userId?,
errorCode })`, and the pure `scrubEvent` function live in
  `@offense-demo/observability`, not `apps/web`: `apps/realtime` may depend on
  `@offense-demo/observability` but never on `apps/web` (ADR 0031 §12's allowed
  edges, mechanically enforced by `scripts/check-boundaries.ts`), and both
  apps must report errors through the one port. The context type accepts
  only those four fields; any other identifier fails typecheck, matching
  ADR 0036 §2's closed vocabulary for the error surface. `@offense-demo/observability` gains a no-op default `ErrorReporter`;
  each app supplies its own vendor adapter and wires it at composition.
- **`apps/web`'s adapter** is `@sentry/nextjs`, at
  `apps/web/src/features/telemetry/`. Call sites: `instrumentation.ts`
  `onRequestError`, the failure path of `handleOperation`, and the client
  `global-error` boundary.
- **`apps/realtime`'s adapter** is a separate, non-Next.js Sentry package
  (its own choice at implementation time — `@sentry/node` or
  `@sentry/bun`, whichever the installed docs support for a Bun server
  process) at `apps/realtime/src/telemetry/`, implementing the same port
  with the same `scrubEvent`. It is not a lesser-monitored surface because
  it runs outside `apps/web`.
- `scrubEvent` runs as `beforeSend` in both adapters: `sendDefaultPii:
false`, drops the request body, cookies, headers, query string, IP and
  console breadcrumbs, sets `user = { id }` with the cuid2 id only, and
  turns off session replay on the Sentry side (product-analytics replay is
  PostHog's, gated separately below, and applies to `apps/web` only —
  `apps/realtime` has no browser surface).
- **Raw exceptions go only to the scrubbed error tracker, after
  `scrubEvent`, and never to logs.** Logs keep safe structured metadata:
  `errorCode`, `errorClass`, `operation`, `invariantId` and `requestId`.
  `errorClass` is a controlled enum of normalized internal failure types —
  `db.timeout`, `redis.unavailable`, `vendor.http`, `validation`,
  `invariant` and similarly named cases — declared once in the log-field
  vocabulary. It is never the exception's class name or message,
  so a log line stays useful for diagnosis and dashboards without ever
  carrying raw content, and it lets a log line be joined to its Sentry
  event through the shared `requestId` without the log itself needing the
  exception.
- With no DSN configured for a given adapter, that adapter's SDK is not
  initialized and makes no network request (§ Configuration and region
  below states which variable gates which adapter). `@sentry/*` imports
  outside the two adapter modules are rejected by the policy gate.

### Product analytics and consent (PostHog)

- A product event registry (`apps/web/src/features/analytics/events.ts`)
  gives every event a strict property schema; personal, sensitive and
  secret properties are rejected by the type system and a registry test,
  per ADR 0036's classification. `track(event, props)` runs on client and
  server and is a no-op with no key set.
- The PostHog client SDK sits behind an **opt-in** consent banner (owner
  decision, 2026-09-22), never behind default tracking with an opt-out.
  Before opt-in: `opt_out_capturing_by_default: true`,
  `persistence: 'memory'`. After opt-in: cookie persistence.
  `person_profiles: 'identified_only'`; `identify` is called with the cuid2
  id only. Session replay is gated separately on the `replay` consent
  category, with `maskAllInputs`. The server-side `track` checks the
  request's consent cookie before sending anything.
- Analytics events carry exactly one of `anonymousId` or `userId`
  (ADR 0036 §2); this ADR does not restate that rule, it only points the
  PostHog adapter at it.
- With no PostHog key, the analytics category is hidden from the UI and
  the SDK is never initialized, while the stored consent schema still
  keeps all three categories per ADR 0036 §5. `posthog-js`/`posthog-node`
  imports outside their adapter are rejected by the policy gate.

### Configuration and region

All vendor variables are optional in `packages/config`, and an adapter
initializes only when its own variables are present. The two Sentry
variables are separate, independently optional guards, not one shared
switch, matching `@sentry/nextjs`'s own per-runtime config convention
(`sentry.server.config.ts`, `sentry.client.config.ts`,
`sentry.edge.config.ts`):

- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`: gate every server-side capture path —
  `apps/web`'s server and edge runtimes (`instrumentation.ts`
  `onRequestError`, `handleOperation`'s failure path) and `apps/realtime`'s
  own adapter, which reads the same variable names from its own process
  environment as a separate deployment. With `SENTRY_DSN` unset, no server
  makes any Sentry network call.
- `NEXT_PUBLIC_SENTRY_DSN`: gates `apps/web`'s client (browser) capture
  only — the `global-error` boundary — and is inlined into the browser
  bundle at build time like any other `NEXT_PUBLIC_*` variable (the same hazard applies to PostHog's public key). With it
  unset, the browser makes no Sentry network call even if `SENTRY_DSN` is
  set for the server. A deployment may run server-side capture without
  client-side capture by setting only `SENTRY_DSN`; the reverse (client
  without server) is legal but not a configuration the template expects
  to use. Full inertness — no Sentry call from any runtime — requires both
  variables unset.
- `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (region)
- `POSTHOG_API_KEY` (server-side events and person deletion)

The vendor region (US-first, GDPR-ready) is chosen by which host and DSN a
deployment sets, never by application code. `proxy.ts`'s CSP allows the
configured Sentry and PostHog hosts only when their variables are set, so
an unconfigured deployment's CSP names no vendor host at all.

## Consequences

- `docs/operations/observability.md`'s "vendors belong to deployment; adding
  an SDK requires an ADR" line is superseded for Sentry and PostHog
  specifically: this ADR is that ADR, and both adapters ship in-repo,
  inert without keys. The line stands unchanged for any other vendor.
- The logger work adds `errorClass` to the closed log-field vocabulary and its enum.
- The error-tracking work implements the `ErrorReporter` port and `scrubEvent` in
  `@offense-demo/observability`, the `@sentry/nextjs` adapter in `apps/web`, the
  separate `apps/realtime` adapter, configuration and the import/capture
  policy ban for both. `docs/architecture/overview.md`'s package-map row
  for `@offense-demo/observability` gains the `ErrorReporter` responsibility.
- The analytics work implements the product event registry, the consent banner and
  model (mechanism only — the model itself is ADR 0036 §5), the
  `consent_record` table, the PostHog adapter and its policy ban.
- `docs/dependencies.md` registers `@sentry/nextjs`, `posthog-js` and
  `posthog-node` as adopted by this ADR; a package is installed in the same
  change as its adapter code.
- Vendor account creation, DPAs, region sign-off and deploy secrets stay
  a human-only task; this ADR fixes the mechanism, not the sign-off.

## Sources

- Sentry Next.js SDK, `beforeSend` and PII controls:
  https://docs.sentry.io/platforms/javascript/guides/nextjs/
- Sentry data scrubbing (`sendDefaultPii`, server-side scrubbing):
  https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/sensitive-data/
- PostHog JS opt-out and persistence configuration:
  https://posthog.com/docs/libraries/js
- PostHog person profiles and `identify`:
  https://posthog.com/docs/product-analytics/identify
- PostHog session replay input masking:
  https://posthog.com/docs/session-replay/privacy
- PostHog person deletion API (server-side erasure):
  https://posthog.com/docs/api/persons
