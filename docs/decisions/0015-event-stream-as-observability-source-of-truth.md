# 0015: Event stream as the observability source of truth

Status: accepted.

The structured event stream is the source of truth for application
observability. Each emitted JSON log entry records an observed lifecycle or
failure event and is the canonical record used to answer operational
questions. Traces and metrics may add correlation and aggregation, but they
are supplementary: tracing is provider-neutral and may be a no-op until the
deployment installs an OpenTelemetry provider, while the application always
emits its event stream to the configured logger destination.

The event registry in `@offense-demo/logger` is the source of truth for the allowed
event vocabulary and registry-declared severity. It is not an event history.
Callers use the event-based logger API rather than selecting a severity or
inventing event names. Runtime names outside the registry normalize to
`telemetry.unknown_event`; operation names and other dimensions remain
structured fields.

The current registry is:

| Event                              | Severity | Owner / emission boundary                         |
| ---------------------------------- | -------- | ------------------------------------------------- |
| `runtime.initialize`               | info     | Next runtime initialization                       |
| `server.start`                     | info     | HTTP server listening                             |
| `server.shutdown`                  | info     | Shutdown begins draining                          |
| `ingress.trusted_proxy.unresolved` | warn     | Start finds no single gateway for `gateway`       |
| `http.request.completed`           | info     | Request operation returns a response              |
| `http.request.cancelled`           | warn     | Request aborts before completion                  |
| `http.request.failed`              | error    | Request operation or server handler fails         |
| `invariant.violated`               | error    | Request operation violates a registered invariant |
| `auth.rate_limit.denied`           | warn     | Auth rate-limit gate denies a request             |
| `auth.rate_limit.unavailable`      | error    | Auth limiter or client resolution fails closed    |
| `auth.session.unavailable`         | error    | Session store unreadable; request refused (503)   |
| `auth.mail.sent`                   | info     | Auth mail seam hands a message to the transport   |
| `auth.mail.failed`                 | error    | Auth mail seam delivery failure                   |
| `request.unhandled`                | error    | Next reports an unhandled request failure         |
| `db.query.failed`                  | error    | Database adapter query/transaction failure        |
| `redis.command.failed`             | error    | Redis adapter command failure                     |
| `telemetry.unknown_event`          | warn     | Logger receives an unregistered runtime name      |

All entries include logger base fields (`service`, `appVersion`, and
`gitCommit`) and the canonical `event` field. Request events also carry
request-scoped correlation fields where available; adapter failures carry the
adapter operation. Sensitive values, raw request bodies, raw exceptions,
credentials, and cookies are not event data.

This decision does not make Redis or process memory authoritative product
storage; PostgreSQL remains the durable source of durable records under
ADR 0007. It defines the authoritative source for operational telemetry and
requires deployment infrastructure to retain and route the logger’s
structured output if historical investigation is needed.
