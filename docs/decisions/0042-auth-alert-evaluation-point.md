# 0042: The auth alert evaluation point runs outside the app

Status: accepted. Extends [ADR 0015](0015-event-stream-as-observability-source-of-truth.md)
(the event stream stays the source of truth; this ADR only adds a
derived, durable read of it) and follows AGENTS.md's standing rule that
Redis state be validated, namespaced keys with expiry. Applies
[ADR 0036](0036-privacy-by-design.md)'s
classification to every new field. Builds on
[docs/operations/observability.md](../operations/observability.md)'s
existing "alert on `auth.rate_limit.unavailable`, `auth.session.unavailable`
and `auth.mail.failed`" line by shipping the mechanism that line only
described as intent.

## Context

The auth operations requirements ask for four tested alert conditions delivered to an operator
(storage/limiter unavailable 2 minutes, 3 consecutive delivery-provider
failures, auth 5xx above 1% over 10 minutes with at least 100 requests,
cleanup missed 2 hours), bounded-cardinality dashboards, and a 5-minute
non-mutating health/session probe of the final public origin — all without
a new alerting service or vendor, using the existing PageSpace Incidents
path (`scripts/notify-drive.ts incidents`, owner decision 2026-09-25).

The design constraint that forces a real decision: an evaluator running
inside the Next.js process cannot alert on its own unavailability while it
is down, restarting or crash-looping — the one failure mode most worth
alerting on is exactly the one an in-process timer cannot see. That holds
with staging always on (owner decision, `fly.toml`'s
`min_machines_running = 1` and `auto_stop_machines = "off"`).

## Decision

**The evaluator is a scheduled GitHub Actions workflow
(`.github/workflows/auth-alerts.yml`), not a timer inside the app.**
Configured for every 5 minutes (`cron: '*/5 * * * *'`) — though GitHub's
`schedule` trigger does not actually deliver that cadence in production;
see the corrected cadence below (ADR 0046). Each run it:

1. Sends one non-mutating `GET /api/health/ready` to the public origin and
   checks the response status (routing: an expected 200), the fact the
   `fetch` completed at all against an `https://` URL (TLS: an invalid or
   expired certificate throws before any status returns — no separate
   certificate-inspection library), and the fixed security-header contract
   `next.config.ts` already sets on every response
   (`X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`,
   `Referrer-Policy`). This is the requirements' "5-minute, non-mutating health and
   session probe of the final public origin" criterion. A failed probe
   means the origin was unavailable when the probe ran. Staging is always
   on, but a deploy, restart or crash still takes the machine
   through start-up, when readiness answers 503, so a single
   failure can also land in that window.
2. Reads the already-evaluated conditions from `GET /api/ops/alerts`, a new
   bearer-token-gated endpoint the app itself serves.
3. Posts whatever fired to the Incidents channel via the existing
   `bun scripts/notify-drive.ts incidents --message`, naming each
   condition's own runbook section in `docs/operations/auth-delivery.md`.

The probe never ends without posting when something is wrong. Each of its two requests is abandoned after
`PROBE_FETCH_TIMEOUT_MS` (20 s) and each Incidents delivery attempt after
`NOTIFY_ATTEMPT_TIMEOUT_MS` (20 s, three attempts), so a run where every
request hangs still posts in about 100 s, well inside the job's 5-minute
`timeout-minutes`. It validates the `/api/ops/alerts` body with a small,
pure, hand-written validator (`parseAlertsBody`): a malformed body, an
entry that is not a condition, or an unknown condition id posts as an
unreadable alert state. Anything that throws before the decision posts a
fail-closed message and exits 1.

Its exit code says whether Incidents heard about it: 0 when the run is
healthy or its alert was delivered, 1 when the post failed or the probe
threw (after it tried to post), and 2 for a usage error.

The probe and `notify-drive` run with nothing installed. They
and every module they load import only relative modules and `node:`/`bun`
builtins, never a package. The job has no install step and runs the probe
with `bun --no-install`, so nothing is ever fetched, and a registry outage
cannot stop the probe from posting. `scripts/verify-deploy-config.ts` walks
their runtime import graph and refuses any package import, and it refuses a
workflow that installs anything or drops `--no-install`.

`scripts/auth-alert-probe.ts` is the workflow's script: pure
`evaluateOriginProbe`/`composeAlertMessage` functions, unit-tested, plus a
thin `main()` that performs the two fetches and shells out to
`notify-drive.ts`. It never reimplements a threshold — those live in
exactly one place.

**Where each condition's state lives, and why:**

- **Storage/limiter unavailable.** The app already emits
  `auth.session.unavailable`/`auth.rate_limit.unavailable`. A new
  `withAlertRecording` tap around the composed `Logger` (`app.ts`) observes
  every event the app already logs and, for these two, writes a
  first-observed timestamp to Redis with `markOccurrenceSince` (an atomic
  Lua primitive: `SETNX`+`PEXPIRE` on the first occurrence, `PEXPIRE` only
  — keeping the original since-value — on every later one) under a
  3-minute TTL, re-armed on every occurrence — long enough to bridge a gap
  between two failures of the same incident without pinning the "since"
  time to the most recent one, and to keep that since-time alive for the
  whole length of a continuous outage rather than only its first 180s.
  A quiet period longer than the TTL resets the next
  incident's clock. `evaluateAlerts` fires once `now - since >= 2 minutes`.
  The limiter shares that Redis, so the recorder also keeps the limiter's
  since-time in process under the same bridging rule, and
  `readAlertSnapshot` reports the earlier of the two.
  Each of those reads is bounded by `ALERT_STATE_READ_TIMEOUT_MS` (2 s,
  readiness's own PING budget), so a Redis that stops answering counts
  as a failed read. When the Redis read fails, the snapshot is
  marked `redisState: 'unreachable'` and `evaluateAlerts` checks only
  `limiter_unavailable`, from the in-process since-time; every other
  condition waits for Redis to return, and the probe posts that unread
  state as well as any condition that fired.

  The in-process marker covers exactly one case: the instance answering
  the probe itself saw a limiter failure at least 2 minutes earlier and
  another within the last 3 minutes. It lives in one process's memory.
  Staging is always on, but a deploy, restart or crash still
  starts a new process whose marker is empty; an instance that served no
  auth traffic during the outage has none; and with more than one web
  machine each keeps its own, so the probe sees only the one it reaches.
  Readiness covers every one of those cases: it answers 503
  while Redis is unreachable, and the probe posts that. Running more than
  one web machine needs a shared store for this marker, chosen under a new
  ADR, before `limiter_unavailable` can be exact.

- **Consecutive delivery-provider failures.** `auth.mail.failed` increments
  a bounded Redis counter (`incrementWithExpiry`, a new atomic
  `INCR`+`PEXPIRE`-on-first-hit primitive) with a 1-hour TTL;
  `auth.mail.sent` deletes it. Fires at 3.
- **Auth 5xx rate.** `http.ts` now logs `status` on `http.request.failed`
  too (previously only `http.request.completed` did, which undercounted
  thrown-error responses — the majority of real 5xx). The tap increments a
  per-minute Redis counter for both the total and 5xx-only count, scoped to
  operations whose name starts with `auth.` (bounded: the auth route
  surface is a small, known set of operation names, never a raw path).
  `handleOperation` binds `operation` on its request-scoped child logger,
  not on the completion call, so the tap observes each event with every
  field its ancestors bound merged under the call's own; one tap feeds the
  alert recorder and the metrics store once each (`apps/web/integration/auth-alert-counters.integration.ts`).
  `readAlertSnapshot` sums the trailing 10 one-minute buckets (each with an
  11-minute TTL) and fires at `total >= 100 && serverErrors/total > 0.01`.
  These buckets live in Redis, so `auth_5xx_rate` is blind to a Redis
  outage: the 503s it causes are never counted. `limiter_unavailable`
  covers that outage, since every auth route passes the limiter, and the
  probe's readiness check answers 503 throughout.
- **Cleanup missed.** `retention.sweep.completed` sets a durable
  `alert-retention-last-success` marker (30-day TTL, effectively
  "durable" relative to the 2-hour threshold); `retention.sweep.failed`
  touches nothing, so a persistently failing or never-running sweep goes
  stale on its own. Fires at `now - lastSuccess >= 2 hours`, or immediately
  if the marker has never been set at all (covers "a sweep that never
  ran" — accepted trade-off: a fresh deploy can show this condition for the
  few seconds between boot and the `runOnStart` sweep's first completion,
  a window no probe run — at any cadence — is likely to land inside).
- **Mail shed past the bound.** A saturated sign-up ceiling
  hands each magic-link request's lookup and send or drop to bounded work
  after its answer (ADR 0025). Work past the bound is shed and
  logged as `auth.mail.shed`, and real sign-ins get no mail. The tap
  increments a per-minute `alert-mail-shed-<minute>` counter (11-minute
  TTL, like the 5xx buckets), and `readAlertSnapshot` sums the trailing
  `ALERT_THRESHOLDS.mailShedWindowMinutes` (10) into `mailShed.count`.
  `mail_shed` fires at `ALERT_THRESHOLDS.mailShedCount` (20). A saturated
  minute with real sign-in traffic can shed a stray task, so it waits for
  a sustained count, and any flood that fills the bound sheds far more:
  every request past the 576 held or waiting tasks. The counter carries no address,
  token or task identity. Like every Redis-backed condition, it is not
  evaluated while Redis is unreadable.
- **Magic-link requests limited per network.** A magic-link
  request over its client's IPv6 /56 or /48, or IPv4 /24, limit (ADR 0025)
  is refused and logged as `auth.rate_limit.network_denied` with its scope
  only. The tap increments a per-minute `alert-network-denied-<minute>`
  counter (11-minute TTL, all scopes together), and `readAlertSnapshot`
  sums the trailing `ALERT_THRESHOLDS.networkDeniedWindowMinutes` (10) into
  `networkDenied.count`. `network_limited` fires at
  `ALERT_THRESHOLDS.networkDeniedCount` (300): more than a busy shared
  network trips by accident, far less than one /48 flooding at full rate
  (about 196,000 refusals a minute). The refusals already protect the pool,
  so this tells operators a flood is under way rather than stopping it.
  Like every Redis-backed condition, it is not evaluated while Redis is
  unreadable.

**Redis, not Postgres, holds every durable alert marker**, including the
retention one (the limiter's in-process copy above is not durable), even
though ADR 0023/persistence.md name PostgreSQL the source of durable
truth and Redis expendable. This is a deliberate, bounded
trade-off: Fly Redis for this deployment is Upstash, a managed service
independent of the web app's machines (`docs/operations/deploy-staging.md`),
so it does not go down with the app and normally survives exactly the
outage this system exists to detect. The failure mode this accepts — an
operator-initiated Redis flush silently resetting `alert-retention-last-success`
to "unknown" — produces at most one avoidable `cleanup_missed` alert cycle,
never a missed one, and adds no new migration, table, or write path to the
sweep's own transaction. A durable Postgres row was considered and rejected
for this reason: the leaf's own alerting requirement does not justify a
second write path into the retention sweep's already-carefully-bounded
transaction boundary (`retention.ts`'s comment on why batches are never
wrapped in one transaction).

**`/api/ops/alerts` and `/api/ops/metrics` are gated by one new
`OPS_PROBE_TOKEN`** (`packages/config`'s `REQUIRED_IN_PRODUCTION` list),
compared as SHA3-256 digests rather than raw strings (ADR 0019's
secret-comparison rule). Both are non-mutating `GET`s, `handleOperation`-wrapped
like every other route, and each route handler's own closure reads
`app.opsProbeToken()` lazily, per request, rather than at route-table
construction — the same treatment `confirmAuth` already gets elsewhere in
`routes.ts` (ADR 0020: a bare, unactivated `App` instance never requires
auth variables just to exist). That per-request laziness is not the same
claim as "optional in production": `apps/web/src/server/start.ts` (through `createProductionServer`) reads
`app.auth().config` unconditionally before the server ever listens, and
`readAuthConfig`'s production `superRefine` (`packages/config/src/index.ts`)
requires `OPS_PROBE_TOKEN` there exactly like `RESEND_WEBHOOK_SECRET` — a
production deploy with no `OPS_PROBE_TOKEN` set refuses to boot, the same
fail-closed shape as every other required auth secret, not a route that
quietly 401s while the rest of the app runs.

**Bounded-cardinality dashboards are an in-process Prometheus text
exposition endpoint (`/api/ops/metrics`), not a new vendor.** Counters:
auth HTTP responses by status class (`2xx`/`3xx`/`4xx`/`5xx` — 4 values),
rate-limit denied/unavailable totals, mail delivery failure total, and
retention sweep failures by target name (`retentionTargets`' own fixed set
of ~6 names), plus the `auth_http_request_duration_ms` latency histogram
by operation (`KNOWN_OPERATIONS` plus `other`). No field is ever an email,
token, IP, or other unbounded value. Each counter, the histogram and each
alert marker is proven through the
composed app, from real requests, outages and sweeps, by
`apps/web/integration/auth-alert-counters.integration.ts` and
`auth-ops-signals.integration.ts`, the limiter-unavailable
one through a real Redis outage. Prometheus text exposition was chosen because it needs no client
library (plain string formatting) and is the format Fly's own `[metrics]`
scrape config and any Prometheus-compatible dashboard already understand;
this ADR ships the data source only. **Wiring an actual scrape config
(`fly.toml`'s `[metrics]` block) or a rendered dashboard is a deploy-rail
change and stays with the owner** (AGENTS.md: "Deploy-rail and
production-data changes require a human-only sign-off leaf; agents never
self-approve") — tracked as a follow-up, not built here.

**Privacy classification.** Every new Redis marker and metrics counter is
category `none` under ADR 0036 §1: a timestamp, a bounded count, or a fixed
enum label (status class, retention target name) — never an email, token,
IP, or other identifier. `packages/db/src/schema/data-inventory.ts` (the
single declaration ADR 0036 §3 and privacy.md describe) does not exist yet
for any Redis key, including the pre-existing rate-limit and presence
namespaces; this ADR follows that same not-yet-built state rather than
introduce a one-off inventory file for only these new keys. When the inventory
lands, the `alert-*` keys and `/api/ops/metrics`'s counters classify as
`none` alongside the rest of `packages/redis`'s namespaces.

**Known limitations, accepted rather than engineered around:**

- **Corrected by [ADR 0046](0046-auth-alert-probe-cadence-correction.md):**
  this bullet originally read "GitHub's `schedule` trigger is best-effort
  and can run a few minutes late under platform load." Measured over 43.5
  hours, the real gap between runs is 2–5 hours, not minutes —
  GitHub's own docs describe delays "as much as 15 minutes, or even longer,"
  and this deployment falls well past even that. The 2-minute and
  10-minute alert windows lapse between runs at the cadence actually
  observed; only the 2-hour `cleanup_missed` condition reliably survives
  the gap between scheduled runs on its own. **Owner decision (2026-09-28): keep this exact mechanism and accept its best-effort
  cadence** rather than build an always-on in-app evaluator or a dedicated
  prober machine; the original five-minute figure is amended to best-effort for
  staging. Proving the other three conditions live uses an independent
  trigger plus `workflow_dispatch`, not the schedule itself.
- `/api/ops/metrics` counters are per-process (reset on restart, not
  aggregated across instances in-app) — the normal Prometheus convention; a
  scraper aggregates across instances and restarts at query time, not this
  endpoint.
- Alerts do not deduplicate across probe runs: a condition that stays true
  re-alerts on every run until it clears — at the real, best-effort cadence
  (ADR 0046), not every 5 minutes. The requirement is a fired,
  runbooked alert, not an incident-management system; silencing is an
  operator action via the runbook, not a feature this ADR adds.
- **The probe's cadence has no bearing on cost.** Staging's web machine
  runs continuously under an owner decision (`min_machines_running =
1`, `auto_stop_machines = "off"`), about $3.99/month on its own; each
  real probe run requests a machine that is already running. **Owner
  decision (confirmed, amended by ADR 0046, 2026-09-28)**:
  keep this mechanism and accept its real cadence. See
  `docs/operations/deploy-staging.md`'s "Cost" table.

## Consequences

- `packages/redis`: `markOccurrenceSince`, `incrementWithExpiry` (new atomic
  primitives).
- `packages/config`: `OPS_PROBE_TOKEN` (new, production-required auth
  field).
- `apps/web`: `alert-state.ts` (pure `evaluateAlerts`), `alert-snapshot.ts` (`readAlertSnapshot`),
  `alert-recorder.ts` (`createAlertRecorder`, `withAlertRecording`),
  `metrics-store.ts`, `features/ops/{alerts,metrics,probe-auth}.ts`, two new
  routes (`/api/ops/alerts`, `/api/ops/metrics`), and `http.ts` now logs
  `status` on `http.request.failed`.
- `scripts/auth-alert-probe.ts` and `.github/workflows/auth-alerts.yml`
  (new scheduled workflow, SHA-pinned actions, secrets scoped to one step
  per ADR 0040).
- `docs/operations/auth-delivery.md` gains one runbook subsection per
  condition plus the probe; `.env.example` and every test harness that
  boots a production-mode app (`playwright.config.ts`,
  `scripts/auth-load/two-instances.ts`) gain an inert `OPS_PROBE_TOKEN`
  placeholder.
- A follow-up (filed as an Issue, see the handoff) tracks wiring
  `/api/ops/metrics` into an actual scrape config/dashboard — an owner
  deploy-rail decision, not part of this change.

## Sources

- Fly.io `auto_stop_machines`/`auto_start_machines`/`min_machines_running`:
  https://fly.io/docs/reference/configuration/#the-http_service-section
- Fly.io metrics and Prometheus scraping:
  https://fly.io/docs/reference/metrics/
- Prometheus text exposition format:
  https://prometheus.io/docs/instrumenting/exposition_formats/
- GitHub Actions `schedule` trigger reliability notes:
  https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule
