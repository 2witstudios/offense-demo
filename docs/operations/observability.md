# Observability

Provider-neutral OpenTelemetry instrumentation exists from day one; tracing
exporters belong to deployment, not the repository. Error tracking and
product analytics are the deliberate exception:
[ADR 0037](../decisions/0037-error-tracking-and-product-analytics.md) ships
in-repo Sentry and PostHog adapters that stay inert without their
deploy-time keys — see [privacy](privacy.md) for the classification and
consent rules those adapters must follow. Any other vendor SDK still
requires its own ADR before it may be added.

## Source of truth

The structured event stream emitted by `@offense-demo/logger` is the operational
source of truth. Query the JSON log entries for what happened; use `traceId`
and metrics as supplementary correlation and aggregation. A trace may be
absent when the deployment has no OpenTelemetry provider, but lifecycle and
failure events still go to the logger destination. The logger event registry
is the source of truth for the permitted event names and their severities,
not a history of emitted events. See [ADR 0015](../decisions/0015-event-stream-as-observability-source-of-truth.md).

## Current state

- `@offense-demo/observability` wraps the OTel API only: `withSpan` for meaningful
  boundaries, `currentTraceId`, request-ID correlation, `withTimeout` for
  bounded waits. Without a provider installed, spans are no-ops — cheap and
  safe.
- `apps/web/src/instrumentation.ts` registers server runtime initialization
  and `onRequestError`, tagging unhandled failures with route, request ID,
  and deployment identity.
- `handleOperation` (web server layer) binds a request-scoped child logger with
  `operation`, `requestId`, and `traceId`, then emits
  `http.request.completed`, `http.request.cancelled`, or `http.request.failed`
  with structured lifecycle fields — never formatted strings.
- The Next Proxy validates an ingress `traceparent` before forwarding it; the
  HTTP boundary extracts that W3C context as the parent of the request span.
- The logger embeds `appVersion` and `gitCommit` (deployment identity) in
  every line; production config refuses to boot without them.
- Logger events use a compile-time vocabulary and registry-declared severity;
  callers emit through one event-based method, and untrusted runtime event
  names normalize to `telemetry.unknown_event`. Dynamic operation names remain
  structured context fields.
- Database and Redis adapters accept provider-neutral injected event sinks and
  emit `db.query.failed` or `redis.command.failed` with the operation name when
  an external query or command fails. They rethrow the original failure and do
  not depend on the logger package.

## Event registry

The logger accepts these events. The registry, rather than caller
selected log levels, controls severity. This table is checked against
`@offense-demo/logger`'s `eventRegistry` by
`scripts/observability-docs-drift-guard.test.ts`, which fails if they
diverge:

| Event                                    | Severity | Meaning                                                                                                                |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `runtime.initialize`                     | info     | The application runtime initialized                                                                                    |
| `server.start`                           | info     | The HTTP server began listening                                                                                        |
| `server.ready`                           | info     | Start-up work finished and requests reach Next; `durationMs` is the time since `server.start`                          |
| `server.shutdown`                        | info     | Shutdown began draining requests                                                                                       |
| `ingress.trusted_proxy.unresolved`       | warn     | `AUTH_TRUSTED_PROXIES` names `gateway` but no single default gateway was found at start, so none is trusted            |
| `http.request.completed`                 | info     | A request operation returned a response                                                                                |
| `http.request.cancelled`                 | warn     | A client/request signal aborted before completion                                                                      |
| `http.request.failed`                    | error    | A request operation or server handler failed                                                                           |
| `invariant.violated`                     | error    | A request operation violated a registered invariant                                                                    |
| `auth.rate_limit.denied`                 | warn     | The auth rate-limit gate denied a request (public 429)                                                                 |
| `auth.rate_limit.unavailable`            | error    | The auth limiter or client resolution failed; denied with a public 503                                                 |
| `auth.rate_limit.network_denied`         | warn     | A magic-link request was refused for its client's IPv6 /56 or /48 or IPv4 /24 (`scope` only)                           |
| `auth.session.unavailable`               | error    | The session store could not be read; guarded pages and the username claim answer 503, never a sign-out                 |
| `auth.mail.sent`                         | info     | An auth email was handed to the mail transport                                                                         |
| `auth.mail.failed`                       | error    | Auth email delivery failed                                                                                             |
| `auth.mail.receipt_failed`               | error    | The provider accepted a message but recording its receipt failed                                                       |
| `auth.mail.suppressed`                   | info     | An auth email was not sent because its recipient is suppressed (hard bounce or complaint)                              |
| `auth.mail.shed`                         | warn     | Saturated sign-in/sign-up work was shed after its answer because its backlog was full (`pending` count only)           |
| `auth.mail.abandoned`                    | error    | The shutdown deadline cut off auth work handed off past its answer (`pending` count only)                              |
| `auth.magic_link.verified`               | info     | A magic-link token was redeemed and a session established                                                              |
| `auth.passkey.enrolled`                  | info     | A passkey registration ceremony completed                                                                              |
| `auth.passkey.authenticated`             | info     | A passkey authentication ceremony completed                                                                            |
| `auth.passkey.removed`                   | info     | An owned passkey was deleted                                                                                           |
| `auth.passkey.notification_failed`       | error    | The added/removed security notification email could not be sent                                                        |
| `auth.session.revoked`                   | info     | A single named session was revoked, from `/api/auth/revoke-session` or the account UI's `/api/account/sessions/revoke` |
| `auth.session.revoked_all`               | info     | Every other session for the account was revoked                                                                        |
| `auth.email_change.requested`            | info     | A fresh session started a recovery-email change                                                                        |
| `auth.email_change.verified`             | info     | Ownership of the new address was verified and the change completed                                                     |
| `auth.email_change.cleanup_failed`       | error    | A scheduled email-change-token cleanup batch failed                                                                    |
| `realtime.outbox.append_failed`          | error    | Appending to the transactional outbox failed                                                                           |
| `realtime.outbox.drain_failed`           | error    | A drain pass's range read or sink call failed; the loop stays alive and the next wakeup retries                        |
| `realtime.outbox.delivery_lag_estimated` | info     | A readiness probe estimated the drain's seq-distance from the outbox high-water mark                                   |
| `realtime.connection.rejected`           | info     | A realtime socket connection was rejected                                                                              |
| `request.unhandled`                      | error    | Next reported an unhandled request failure                                                                             |
| `db.query.failed`                        | error    | A database query or transaction failed                                                                                 |
| `retention.sweep.completed`              | info     | One retention target (`operation`) swept its bounded batches                                                           |
| `retention.sweep.failed`                 | error    | One retention target failed; the sweep moved on and retries next hour                                                  |
| `redis.command.failed`                   | error    | A Redis command failed                                                                                                 |
| `telemetry.unknown_event`                | warn     | An unregistered runtime event name was normalized                                                                      |

Lifecycle events describe runtime, server, and request progress. Failure events
describe invariant violations, unhandled requests, and adapter failures;
`http.request.cancelled` is an expected client-abort signal and is intentionally
warning-level rather than an error. Invariant events carry only the stable
`invariantId`; adapter events preserve the original failure for the caller to
handle and record only the safe operation context. Auth events carry only
`operation`, the stable auth route `path` where applicable, and an
`errorCode`: never the recipient, token, link URL, client address, limiter
key, or provider exception. The `auth.magic_link.*`, `auth.passkey.*`,
`auth.session.*`, and `auth.email_change.*` lifecycle milestones
carry only `operation` and their own name; they mark that a milestone
happened, not who it happened to — correlate the acting account through
`requestId`/`traceId` and the application's own audit trail, not the log
line. `auth.rate_limit.denied` is expected traffic and is warning-level;
alert on `auth.rate_limit.unavailable`, `auth.session.unavailable` and
`auth.mail.failed`.

## How to answer production questions

Which request failed / what else happened to it: correlate `requestId`
(proxy-generated at the edge, echoed on responses and error bodies; the
operation layer also honors well-formed caller IDs when the proxy is bypassed)
with `traceId` once a provider is installed. Which deployment:
`appVersion`/`gitCommit` log fields. Which user: pass `userId` as a
structured field at feature-operation level — add it where
the operation knows them, not by re-parsing payloads. A log line carries
only the fields ADR 0019's loggable-field table admits.

For an incident, start with the event stream and filter by `event`, then
correlate `requestId`, `traceId`, `operation`, and deployment fields. The
registry alone cannot answer when an event occurred or which request emitted
it; those facts exist only in the emitted entries.

## Rules

- Instrument meaningful boundaries (HTTP operations, adapter calls,
  scheduled work), not every function.
- Never log credentials, cookies, raw request bodies, or raw exceptions.
  The logger admits only ADR 0019's allowlisted fields of their declared
  kind and fixed-prose messages; that is defense in depth, not permission.
- Tracing exporters/SDK: install at deployment edge (collector sidecar or
  platform integration). Adding an SDK to application packages requires an
  ADR; Sentry and PostHog are the standing exception under ADR 0037.
- Next.js instrumentation hooks are the supported framework surface; do not
  invent framework-specific telemetry.
