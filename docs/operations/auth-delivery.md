# Authentication delivery and abuse protection

Operational contract for `/api/auth/*`, `/auth/confirm` and
`/api/webhooks/resend` (ADR 0025). This page holds the facts operators need to
deploy and to reason about failures.

## Required configuration (production refuses to start without it)

| Variable                | Purpose                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`    | 64 characters from 32 random bytes; signs the session cookie                                                               |
| `RECIPIENT_HASH_SECRET` | 64 characters from 32 random bytes; keys recipient hashes independently of `BETTER_AUTH_SECRET` (ADR 0044)                 |
| `PUBLIC_APP_URL`        | HTTPS canonical origin; derives the passkey RP ID and origin                                                               |
| `RESEND_API_KEY`        | Resend send credential (owner-provisioned; never in PageSpace)                                                             |
| `AUTH_EMAIL_FROM`       | Verified sender mailbox                                                                                                    |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` signing secret of the Resend webhook                                                                             |
| `AUTH_TRUSTED_PROXIES`  | Optional IP/CIDR list of deployment ingress hops (see below)                                                               |
| `OPS_PROBE_TOKEN`       | Bearer credential for `/api/ops/alerts` and `/api/ops/metrics`; the scheduled `auth-alerts.yml` workflow's only credential |

`apps/web/src/server/start.ts` validates these at boot and reports field names
only. `RESEND_API_KEY` and `AUTH_EMAIL_FROM` are required everywhere except
local development. With `NODE_ENV=development`, a loopback `PUBLIC_APP_URL`
(`localhost`, `127.0.0.1` or `[::1]`) and neither variable set, auth mail goes
to the terminal mailer, which prints each message and its link to the
server's stderr as `[dev-mail]` lines instead of sending it
([ADR 0050](../decisions/0050-local-development-terminal-mailer.md)). That is
the one sanctioned place a credential is written out, and it never goes
through the structured logger. Suppression, rate limits and the
`email_delivery` receipt (`dev-mail-…`) behave as for a Resend send; no
delivery webhook follows. `test` and `production` builds (staging included),
and a development server on any other origin, refuse to start auth without
both variables. Live delivery additionally needs a human prerequisite: a
verified Resend domain (SPF, DKIM, initial DMARC monitoring policy) with
**open and click tracking disabled** — tracking is a domain-level Resend
setting the message API cannot override — and a webhook pointing at
`https://<origin>/api/webhooks/resend` subscribed to `email.sent`,
`email.delivered`, `email.delivery_delayed`, `email.failed`, `email.bounced`,
`email.complained`.

## Client identity and ingress assumptions

Rate limits bucket by client: one IPv4 address, or one IPv6 /64 (Better
Auth's `getIP` collapses an IPv6 client to its /64). Magic-link requests
are also counted per IPv6 /56 and /48 and per IPv4 /24 of that client, since one /48 holds 65,536 /64s. There is exactly one
resolver: the composition
trusts only `x-offense-demo-client-ip`, stamped by our own ingress (`start.ts`) on
every request, replacing any caller value. It is the socket peer, or — only
when the peer is in `AUTH_TRUSTED_PROXIES` — Fly's own authoritative
`Fly-Client-IP` (`client-ip.ts`), falling back to the first
address from the **right** of `X-Forwarded-For` that is not itself a
trusted hop only when `Fly-Client-IP` is absent or unusable, so an
attacker-prepended left-most value never selects the bucket. Whichever
it reads, the ingress stamps the address in canonical form
(`canonicalAddress`, `client-networks.ts`): an IPv6 zone id is
dropped, and an IPv6 address that embeds an IPv4 one (mapped
`::ffff:a.b.c.d`, SIIT `::ffff:0:a.b.c.d` or IPv4-compatible `::a.b.c.d`,
in dotted or hex form) is stamped as that IPv4 address. Otherwise
`getIP` would fold such clients into one all-zero /64 and share its
bucket. Better Auth has
no header list of its own to configure: `next dev` runs without the
stamping ingress, so a dev-mode request simply carries no identity and
shares one rate-limit bucket per path with every other unstamped request.

In production, `AUTH_TRUSTED_PROXIES` (with `Fly-Client-IP`, falling back to
`X-Forwarded-For`) is the mechanism for reading the real client behind a
proxy. A proxy not listed there makes all its users share one rate-limit
bucket.

Configure exactly the hops you operate; an over-broad range re-opens spoofing.
Under `next dev` there is no ingress stamp and requests share the loopback
bucket. Verify with the spoofing suite (`auth-ingress.integration.ts`) adapted
to your topology before release.

## Limits and outage behaviour

| Scope                                                              | Limit                         | On exceed                                       |
| ------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------- |
| Any auth route, per client and path                                | 100 / 60 s                    | `429` + `Retry-After`                           |
| Magic-link request, per client                                     | 3 / 60 s                      | `429` + `Retry-After`                           |
| Magic-link request, per IPv6 /56                                   | 30 / 60 s                     | `429` + `Retry-After`                           |
| Magic-link request, per IPv6 /48                                   | 120 / 60 s                    | `429` + `Retry-After`                           |
| Magic-link request, per IPv4 /24                                   | 120 / 60 s                    | `429` + `Retry-After`                           |
| Magic-link request, per recipient                                  | 3 / 60 s, 10 / hour, 20 / day | `429` + `Retry-After`                           |
| Email change, per new address                                      | 3 / 60 s, 10 / hour, 20 / day | `429` + `Retry-After`                           |
| Every magic-link send, whole application; holds back sign-ups only | 120 / 60 s, 3,000 / day       | sign-up: `200`, no mail (logged); sign-in: sent |
| Redis unavailable                                                  | —                             | `503` + `Retry-After: 5`                        |

Every magic-link send counts against the whole-application ceilings, with
or without an account, but only sign-ups are held back (ADR 0025): a drained ceiling alone delays new sign-ups, never sign-in,
but a drained ceiling together with a flood past the handed-off work's
bound sheds sign-in mail as well (see below). A day's
sign-up capacity is 3,000 minus that day's magic-link sign-ins. Past a
ceiling, a sign-up request gets the same `200` as any other and no mail; the saturation shows only as `auth.rate_limit.denied` with
`path: /sign-in/magic-link` in the log. While saturated, the answer comes
before the account lookup and the send or drop, which finish afterwards, so a failed sign-in send also answers `200`: watch
`auth.mail.failed`, and `request.unhandled` with `source:
auth.after-response` for a database failure in that work. That work is
bounded (512 holding a slot, 64 waiting, with only its database steps
gated at 4 at once); past it a request's work is shed with no mail, logged as `auth.mail.shed` and counted as `auth_mail_shed_total` on
`/api/ops/metrics`. Sustained shedding fires the `mail_shed` alert (see
"Alerting" and "Auth mail shed past the bound" below): it means a flood,
real sign-in volume above what the bound drains, or slow or failing mail
delivery, which holds every slot longer so the bound fills sooner. Check
`auth.mail.failed` and the `delivery_failures` alert before assuming a
flood.

The sign-in page offers passkeys in browser autofill, so every visible view
spends one `/passkey/generate-authenticate-options` request (a challenge row
and a slot in that path's bucket) without a click. The page renews it every
4 minutes, before the 5-minute challenge lifetime ends, and re-offers after
any other ending, backing off from 1 s up to 4 minutes while endings keep
arriving quickly, so a failing service is never hammered. A hidden tab
pauses: every tab shares one challenge cookie, and a background renewal
would invalidate another tab's ceremony. Clients behind one untrusted
address share that bucket with the explicit passkey button.

There is no in-process fallback: while Redis is down every auth request that
needs a decision answers `503`. Restore Redis; no state needs replay. Keys
live under `<REDIS_NAMESPACE>:v1:rl:<sha3-256>` and expire with their window:
60 seconds for the per-route and minute buckets, up to a day for the
recipient hour and day ceilings and the whole-application day ceiling.

## Mail failure and bounces

- Provider failure or timeout: the requester sees `503 EMAIL_DELIVERY_FAILED`
  and may retry; the unsent token is never delivered and expires unused.
- Hard bounce or complaint: the address is suppressed (`email_suppression`,
  keyed hash only). Requests for it answer `422 EMAIL_UNDELIVERABLE` with
  guidance to use a passkey or another address; existing sessions and passkeys
  are untouched. No auth mail is sent to it at all: an email change to or
  from it is refused when requested, before any approval mail (a change to
  it with the same `422`, a change from it with `422
CURRENT_EMAIL_UNDELIVERABLE`), and a passkey added/removed notice
  is skipped and logged as `auth.mail.suppressed` (ADR 0025). Clearing a suppression is an explicit operator action on that
  table and should follow confirmation that the mailbox is fixed.
- Diagnostics: `email_delivery` (message ID, status rank, recipient hash) and
  `email_delivery_event` (event ID dedupe). Neither holds an address or a
  payload. The retention sweep deletes event rows 30 days after receipt and
  delivery rows 30 days after their last status change; suppressions are
  never pruned.
- Webhooks that fail signature or tolerance answer `400`. An event for a
  message with no `email_delivery` row is handled by the event's provider
  timestamp (`created_at`): less than two minutes old, it answers `503` with
  `Retry-After: 5` so the provider retries (the receipt may still be
  committing); older, or with no usable timestamp, it answers `200` and is
  discarded.
- Receipt write failure after the provider accepted a message: the request
  still succeeds (the user has the email) and `auth.mail.receipt_failed` logs
  the opaque `providerMessageId`, nothing else about the message. With no
  `email_delivery` row, that message's bounce or complaint is retried while it
  is under two minutes old, then answered `200` and discarded, so no
  suppression is written. Reconcile by finding the message ID in the log.

## Retention of verification records

Every emailed link writes a `verification` row. The identifier is the
purpose and the SHA3-256 digest of the token (`sign-in:…`,
`email-change-approve:…`, `email-change-verify:…`), never the token itself.
The subject is inside `value`: the requested email for sign-in, and the
account id plus both addresses for an email change (ADR 0025). Redeeming deletes the row; unredeemed rows
are purged by the retention sweep in each server process (once at start-up,
then hourly), only once expired for more than 24 hours, at most 20 batches of
500 per run (a bigger backlog drains over later runs). Runs are idempotent and
safe across instances (`SKIP LOCKED`). On shutdown the sweep stops between
batches and the server waits for it before closing the database, so a normal
restart never raises a false failure. Events, with
`operation: 'retention.verification'`: `retention.sweep.completed`
(`deleted`, `batches`) and `retention.sweep.failed` (alert on this one; a
failing run is retried next hour).

No manual action is needed. To purge sooner, restart a server instance (it
cleans once at start-up) or run one bounded batch in `psql`, repeating until it
reports `DELETE 0`:

```sql
DELETE FROM verification WHERE id IN (
  SELECT id FROM verification
  WHERE expires_at < now() - interval '24 hours'
  ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED);
```

## Retention of sessions

A session that is signed out of is deleted immediately, in the same
transaction that revokes it (`revokeOtherSessions`,
`revokeSessionUnlessAddressHeld`); the sweep below never sees a revoked
session, only one that ran to its own `expires_at` and was never signed out
of. Those rows, `ip_address` and `user_agent` included, are purged by the
same hourly, idempotent sweep as `verification`, with the same 24-hour
grace, `SKIP LOCKED` batches (at most 20 of 500 per run) and shutdown
behaviour. Events, with `operation: 'retention.session'`:
`retention.sweep.completed` (`deleted`, `batches`) and
`retention.sweep.failed` (alert on this one; a failing run is retried next
hour).

No manual action is needed. To purge sooner, restart a server instance or
run one bounded batch in `psql`, repeating until it reports `DELETE 0`:

```sql
DELETE FROM session WHERE id IN (
  SELECT id FROM session
  WHERE expires_at < now() - interval '24 hours'
  ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED);
```

## Alerting

Nothing inside the app can alert on its own unavailability while it is
down, restarting or crash-looping, even though staging is always on
(`fly.toml`'s `min_machines_running = 1`), so the evaluation point
for these alerts is a scheduled GitHub Actions workflow
(`.github/workflows/auth-alerts.yml`, `scripts/auth-alert-probe.ts`), not a
timer inside the app — see [ADR 0042](../decisions/0042-auth-alert-evaluation-point.md)
for why. Its cron is configured for every 5 minutes, but GitHub's `schedule`
trigger runs it best-effort — measured runs land hours apart, and the owner
accepted that cadence for staging ([ADR 0046](../decisions/0046-auth-alert-probe-cadence-correction.md)) — so a condition can fire and resolve between runs unseen. On each
run it probes the public origin's readiness endpoint
(non-mutating, proving routing/TLS/security headers) and reads
`GET /api/ops/alerts` (bearer-token gated by `OPS_PROBE_TOKEN`), which
answers the already-evaluated conditions computed by
`apps/web/src/server/alert-state.ts`'s `evaluateAlerts`. Whatever fires is
posted to the drive's Incidents channel via the existing
`scripts/notify-drive.ts incidents --message`, naming the condition's own
runbook below.

The origin probe checks the security headers only on a `200`. Any other
status posts one `origin_probe` line naming the status, not one per missing
header. With the app's headers present it says the app reported not ready:
Postgres or Redis is unreachable (including the cold-boot Redis window) or
the process is draining. With them absent it says the response likely did
not come from the app: Fly's proxy during a cold start, the start-up gate,
or the app down.

The conditions, and the durable Redis marker each reads
(`apps/web/src/server/alert-recorder.ts` writes them by tapping the
existing event stream — no new call sites):

| Condition             | Fires when                                                                                      | Marker                                             |
| --------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `storage_unavailable` | `auth.session.unavailable` persists 2+ minutes                                                  | `alert-unavailable-storage`                        |
| `limiter_unavailable` | `auth.rate_limit.unavailable` persists 2+ minutes                                               | `alert-unavailable-limiter`                        |
| `delivery_failures`   | 3+ consecutive `auth.mail.failed`, reset by `auth.mail.sent`                                    | `alert-mail-consecutive-failures`                  |
| `auth_5xx_rate`       | >1% of auth-operation requests are 5xx over the trailing 10 minutes, with at least 100 requests | per-minute `alert-http-total-*`/`alert-http-5xx-*` |
| `cleanup_missed`      | the retention sweep has not completed successfully in 2+ hours, or never has                    | `alert-retention-last-success`                     |
| `mail_shed`           | 20+ `auth.mail.shed` over the trailing 10 minutes                                               | per-minute `alert-mail-shed-*`                     |
| `network_limited`     | 300+ `auth.rate_limit.network_denied` over the trailing 10 minutes                              | per-minute `alert-network-denied-*`                |

`GET /api/ops/metrics` (same bearer token) exposes the bounded-cardinality
Prometheus counters for an auth dashboard: auth HTTP
responses by status class, rate-limit denied/unavailable totals, mail
delivery failures, and retention sweep failures by target name — no
per-email or per-token labels. Wiring an actual scrape config or rendered
dashboard is a separate, owner-approved deploy-rail step (ADR 0042).

## Incident runbooks

Every instruction below is proved by an existing test: the event or status it
names is asserted by the test file/case cited, so a change that breaks the
diagnostic also breaks `bun test:integration` or `bun test src`.

### Mail delivery is failing

**Symptom:** sign-in/passkey-recovery requests answer `503
EMAIL_DELIVERY_FAILED`, or a bounce guidance message (`422
EMAIL_UNDELIVERABLE`) appears for addresses that should be deliverable.

1. Filter the event stream for `event:"auth.mail.failed"` — every occurrence
   is a Resend send that threw or timed out; the fields carry only
   `operation`/`errorCode`, never the recipient or provider exception
   (`apps/web/integration/auth-database-failures.integration.ts`, "delivery
   failure surfaces a safe retryable error").
2. Check the Resend status page/API directly; the application never persists
   the provider exception, by design.
3. If addresses are unexpectedly suppressed, the row is keyed by
   `recipientKey(deriveRecipientSubkey(RECIPIENT_HASH_SECRET), email)`
   (SHA3-256 of a domain-separated subkey of `RECIPIENT_HASH_SECRET` and the
   normalized address, never `BETTER_AUTH_SECRET`; ADR 0044;
   `apps/web/src/features/auth/recipient-key.ts`), which cannot be
   recomputed from SQL alone — run `bun repl` (or a one-off script) importing
   `recipientKey`/`deriveRecipientSubkey` with the deployment's
   `RECIPIENT_HASH_SECRET` to look up
   `SELECT reason, created_at FROM email_suppression WHERE recipient_hash =
'<computed hash>'`, or correlate via `auth.mail.receipt_failed`'s
   `providerMessageId` against Resend's dashboard. Suppression only follows a
   hard bounce or complaint
   (`apps/web/integration/auth-mail-suppression.integration.ts`, "a hard
   bounce stops automatic resends"). Clearing a row is a deliberate operator
   action taken only after confirming the mailbox is fixed; there is no
   in-app override, by design.
4. If `auth.mail.receipt_failed` is firing repeatedly, the message is still
   sent (the user has their email) but bounce/complaint correlation for that
   `providerMessageId` will be delayed — reconcile using the ID in the log,
   never the address.

### Invalid origin / RP configuration

**Symptom:** every passkey ceremony or state-changing auth POST fails with a
generic `403`/rejected ceremony after a deploy, config change, or new
frontend origin.

1. Confirm `PUBLIC_APP_URL` is the exact HTTPS origin browsers use. Passkey
   `rpID`/`origin` and the same-origin gate both derive from it
   (`apps/web/src/features/auth/server.ts`); a mismatch between the
   configured origin and the browser's actual origin rejects every
   ceremony and state-changing POST, never partially.
2. State-changing calls to the mounted router (`/api/auth/*`) that lack a
   matching `Origin` header answer `403` before reaching Better Auth
   (`apps/web/src/features/auth/handlers.test.ts`, "rejects state-changing
   calls from foreign or absent origins"); `/auth/confirm` and
   `/auth/confirm-email` enforce the same boundary independently
   (`confirm.test.ts`, `confirm-email.test.ts`). A wave of these at once
   after a deploy is the signature of a `PUBLIC_APP_URL` drift, not an
   attack.
3. A wrong-origin WebAuthn ceremony response is rejected with no credential
   stored (`apps/web/integration/auth-passkey-ceremony.integration.ts`, "a
   wrong origin in the ceremony response is rejected") — if this fires for
   every real user (not just adversarial tests), the deployed `rpID`
   (derived from `PUBLIC_APP_URL`'s hostname) no longer matches the
   hostname users are actually on. Changing production RP identity is a
   separately reviewed compatibility decision (spec, "Runtime and package
   boundaries"); never patch around it by relaxing the origin check.

### Database or Redis storage failure

**Symptom:** auth requests answer `503`/`500` in bursts, or rate limiting
appears to stop working (every request allowed, or every request denied).

1. Filter for `event:"db.query.failed"` (Postgres) or
   `event:"redis.command.failed"` — both carry only the safe operation name,
   never SQL text, bound parameters, or the raw driver exception
   (`apps/web/integration/auth-database-failures.integration.ts`, "pool
   lifecycle closes and the app failure boundary reports without SQL
   material"; `apps/web/src/features/auth/rate-limit.ts`'s limiter outage
   path, `apps/web/integration/auth-rate-limit.integration.ts`, "a Redis
   outage answers a safe 503 for every request and never counts locally").
2. A Redis outage fails every rate-gated auth request closed (`503` +
   `Retry-After: 5`), logged as `auth.rate_limit.unavailable`; it never
   silently allows unlimited traffic and never double-counts once Redis
   returns — there is no local fallback counter to reconcile.
3. A Postgres outage while issuing or redeeming a magic link answers a safe
   retryable error with no SQL, parameters, or address in the response body
   or logs (`apps/web/integration/auth-failure.integration.ts`, "a database
   outage while issuing a link" / "...while redeeming").
4. Recovery is passive: once the dependency is reachable again, the next
   request succeeds normally — there is no cache to invalidate or counter to
   reset by hand. If `auth.rate_limit.unavailable` or `db.query.failed`
   continues after the dependency reports healthy, check connection pool
   exhaustion (`packages/db`'s configured `maxConnections`) before assuming
   the dependency itself is still down.

### Session invalidation / revocation failure

**Symptom:** a user reports a device or browser they signed out (or an
account-security action that should revoke sessions) is still authenticated,
or the reverse — a session they expect to still work is unexpectedly signed
out.

1. Confirm the specific milestone fired: `auth.session.revoked` (one named
   other session), `auth.session.revoked_all` (every other session, from
   "sign out of all other sessions" or an email-change completion), or
   `auth.email_change.verified` (which revokes every other session as part
   of completing the change) —
   (`apps/web/integration/auth-session-management.integration.ts`,
   "revoking a specific session and revoking every other session each emit
   their own lifecycle event"; `apps/web/integration/auth-email-change.integration.ts`,
   "completing the change notifies the old address and revokes other
   sessions"). No event means the revocation request never reached the
   server — check for a `403` from the same-origin/fresh-session gate first.
2. Session reads never cache (`cookieCache: { enabled: false }`), so a
   revoked session is denied on the **very next** server check, not after a
   TTL (`apps/web/integration/auth-sign-in-journey.integration.ts`, "a
   revoked session is anonymous on the very next check"). If a revoked
   session still authenticates, the request is not reaching the mounted
   session read at all (a stale CDN/edge cache in front of the app, not an
   application bug) — this composition never caches session decisions
   itself.
3. A sensitive session/credential change (revoke, passkey removal, email
   change) that fails with `401`/`403` on an otherwise-valid cookie is the
   fresh-session gate: these require re-authentication within the last hour
   (`apps/web/integration/auth-session-freshness.integration.ts`, "a stale
   session is refused for revoking..."). Direct the user to sign in again
   (magic link or passkey); this is expected behavior, not a fault.
4. If the session store itself is unreachable, guarded pages and the
   username claim answer `503` (never a silent sign-out), logged as
   `auth.session.unavailable` — treat it as the database/Redis runbook
   above, not as a revocation bug.

### Storage or rate limiter unavailable

**Symptom:** the `storage_unavailable` or `limiter_unavailable` alert fires
(`apps/web/src/server/alert-state.test.ts`, "storage unavailable for
exactly the threshold fires" / "limiter unavailable for 2+ minutes fires
limiter_unavailable").

1. This is the same underlying condition as "Database or Redis storage
   failure" above (`auth.session.unavailable`/`auth.rate_limit.unavailable`);
   follow that runbook to diagnose the outage itself.
2. The alert fires only once the condition has held for 2+ minutes
   (`apps/web/src/server/alert-recorder.test.ts`, "mark the storage
   occurrence, keeping since-time and re-arming the 3-minute bridging TTL"
   proves the marker's since-value is written once on the first occurrence
   and every later occurrence re-arms its TTL without disturbing that
   value) — a single transient failure does not page anyone.
3. No manual reset is needed: every occurrence re-arms the marker's 3-minute
   TTL (`packages/redis/integration/redis.integration.ts`,
   "markOccurrenceSince keeps the since-value and re-arms the TTL on every
   later occurrence..."), so during a continuous outage it never expires,
   and it expires on its own only once occurrences stop for 3 minutes — the
   alert clears passively once the dependency recovers and stays recovered.
4. A full Redis outage takes the limiter and every alert marker with it,
   yet `/api/ops/alerts` still answers: the snapshot reports
   `redisState: "unreachable"`, `limiter_unavailable` fires from the time
   the serving instance itself first saw the limiter unavailable, and the
   Redis-backed conditions (`storage_unavailable`, `delivery_failures`,
   `auth_5xx_rate`, `cleanup_missed`, `mail_shed`, `network_limited`) are
   not evaluated until
   Redis returns
   (`apps/web/integration/auth-ops-signals.integration.ts`, "a Redis outage
   that outlasts the threshold fires limiter_unavailable from when it
   began"). The probe posts that unread state even when readiness passes
   (`apps/web/integration/auth-alert-probe-degraded.integration.ts`), and
   readiness answers 503 while Redis is unreachable, which the probe posts
   too. The in-process `limiter_unavailable` marker belongs to one process
   and is empty after a deploy, restart or crash, so the readiness post may
   be the only one (ADR 0042).
5. If `/api/ops/alerts` itself is unreachable, hangs or answers a body the
   probe cannot validate (a deploy fault, the app down, a proxy answering
   on its path), the probe (`scripts/auth-alert-probe.ts`,
   `fetchAlertConditions` / `decideProbeOutcome`) still posts to Incidents,
   naming the failed request or the unreadable alert state instead of the
   specific condition; posting to Incidents never depends on the dependency
   that is down. Every request is bounded (`PROBE_FETCH_TIMEOUT_MS`,
   `NOTIFY_ATTEMPT_TIMEOUT_MS`, 20 s each), so a hung origin posts in well
   under the job's 5 minutes, and a probe that throws posts a fail-closed
   message before it exits 1 (`scripts/auth-alert-probe-cli.test.ts`,
   `scripts/auth-alert-probe-fail-closed.test.ts`). The probe job's exit
   code says whether Incidents heard about it:
   - 0: the run was healthy, or its alert was delivered.
   - 1: the post itself did not reach Incidents, or the probe threw (after
     it tried to post). Check the job log for the message it printed.
   - 2: a usage error, such as a missing `--origin` or `OPS_PROBE_TOKEN`
     secret. Nothing was probed.

   The probe needs no installed packages: the job installs nothing and runs
   it with `bun --no-install`, so a registry outage cannot stop it
   .

### Delivery provider failing repeatedly

**Symptom:** the `delivery_failures` alert fires
(`apps/web/src/server/alert-state.test.ts`, "3 consecutive delivery
failures fire; 2 does not").

1. Follow "Mail delivery is failing" above to diagnose Resend itself; this
   alert is that same condition crossing 3 consecutive `auth.mail.failed`
   events with no intervening successful send
   (`apps/web/src/server/alert-recorder.test.ts`, "increments consecutive
   mail failures on auth.mail.failed, resets on auth.mail.sent").
2. The counter resets to zero on the next successful send; no manual reset
   is needed once Resend recovers.

### Auth 5xx error rate elevated

**Symptom:** the `auth_5xx_rate` alert fires
(`apps/web/src/server/alert-state.test.ts`, "auth 5xx above 1% with at
least 100 requests fires; below either threshold does not").

1. Filter the event stream for `event:"http.request.completed"` or
   `event:"http.request.failed"` with `operation` starting `auth.` and
   `status >= 500` over the alert's window; both events carry `status`
   (`apps/web/src/server/http.test.ts`, "log the response status alongside
   the error code (5xx-rate alert input)" proves `http.request.failed`
   carries it too, not only the completed path).
2. A burst of `auth.request` 503s usually means the storage/limiter runbook
   above; a burst of `INTERNAL`/`500`s with no matching `db.query.failed`
   or `redis.command.failed` means an application defect, not an outage —
   escalate rather than wait for recovery.
3. The rate is computed over a trailing 10-minute window and requires at
   least 100 requests in that window, so a low-traffic burst of failures
   (fewer than 100 total auth requests) does not page anyone even at 100%
   failure — check `GET /api/ops/metrics`'s `auth_http_requests_total` for
   the actual volume before assuming the alert under- or over-fired.

### Retention cleanup missed

**Symptom:** the `cleanup_missed` alert fires
(`apps/web/src/server/alert-state.test.ts`, "a retention sweep silent for
2+ hours, or never successful, fires cleanup_missed").

1. Filter the event stream for `event:"retention.sweep.failed"` — see
   "Retention of verification records" and "Retention of sessions" above
   for the manual `psql` fallback if a backlog needs draining sooner than
   the next hourly run.
2. If no `retention.sweep.failed` events appear either, the sweep is not
   running at all — check that the app process is up (`GET
/api/health/ready`) and that it has completed at least one boot since
   the last deploy (`retention-sweep.ts`'s `runOnStart` sweeps once at
   start-up, before the hourly schedule).
3. The marker this alert reads (`alert-retention-last-success`) is written
   only on `retention.sweep.completed`, so a sweep that runs but never
   fully succeeds keeps this alert firing even while individual batches
   make progress — that is intentional ("cleanup missed" names
   the failure to _complete_, not the failure to _attempt_).

### Auth mail shed past the bound

**Symptom:** the `mail_shed` alert fires: 20 or more pieces of magic-link
work were shed in the trailing 10 minutes
(`ALERT_THRESHOLDS.mailShedCount` and `mailShedWindowMinutes` in
`apps/web/src/server/alert-state.ts`; proven through the composed app in
`apps/web/integration/auth-mail-shed-alert.integration.ts`). While the
global sign-up ceiling is saturated, every magic-link request's lookup and
send or drop runs after its answer, at most 512 holding a slot with 64
waiting (`after-response.ts`). Everything past that is shed, and **real
sign-ins get no mail** as well as sign-ups. The person sees the
ordinary success and must request another link, or use a passkey. Where
the pool fills depends on the host and its load: 700 to 1,200 new
addresses a second on the development host, unmeasured and lower on
production's machine (ADR 0025). The aggregate network limits keep any
one /48, /56 or IPv4 /24 far below that, so a full pool means a flood
from many networks: about (edge ÷ 2) of them at 2 a second each, which
one IPv6 /40 (256 /48s) or a botnet across a few hundred /24s provides.
This alert is the signal for that flood; blocking the offending ranges
at the edge is the response.

1. Check `auth.rate_limit.denied` with `path: /sign-in/magic-link`. A
   saturated global ceiling is the precondition for shedding. Sustained
   denials with shedding mean a flood of new addresses (rotating clients,
   plus-addressed recipients), or real volume above the ceilings.
2. Check `auth_mail_shed_total` on `/api/ops/metrics` for the rate. The
   alert carries counts only, never an address.
3. Shedding stops as soon as the flood falls below the rate the pool
   drains: the backlog clears within about one provider round trip. The
   ceiling does not necessarily reopen with it. The minute ceiling resets
   each minute, but once the day ceiling (3,000) is spent, new sign-ups get
   no mail until its window ends, up to a day after its first send, while
   sign-in links are still sent. If real volume is the cause, raise the
   ceilings (`MAGIC_LINK_GLOBAL_RULES`, `rate-limit.ts`, and ADR 0025)
   rather than the bound: the bound protects the Postgres pool and the
   process's memory.
4. Check `auth.mail.failed`: a slow or failing provider holds every slot
   longer, so the bound fills sooner.

### Magic-link requests limited per network

**Symptom:** the `network_limited` alert fires: 300 or more magic-link
requests were refused in the trailing 10 minutes because their client's
IPv6 /56 or /48, or IPv4 /24, was over its limit
(`ALERT_THRESHOLDS.networkDeniedCount` and `networkDeniedWindowMinutes`
in `apps/web/src/server/alert-state.ts`; limits in
`MAGIC_LINK_NETWORK_RULES`, `rate-limit.ts`; proven in
`apps/web/integration/auth-network-limits.integration.ts`). The refused
requests got a `429` with `Retry-After`, the same for any address, and did
no work, so the pool and real users outside that network are unaffected.

1. Check `auth_rate_limit_network_denied_total{scope}` on
   `/api/ops/metrics` for which scope is refusing. The alert and the log
   line carry the scope and counts only, never the network or a client.
2. A single /48 or /56 refused at a high rate is one client rotating its
   /64s. Nothing needs doing while the refusals keep it off the pool; if
   it persists, block the network at the edge (Fly, or the upstream
   provider).
3. A /24 or /48 refused at a low, steady rate may be a shared network with
   real users (carrier NAT, a large site). Its users get a `429` and can
   retry a minute later or sign in with a passkey. If that is real demand,
   raise the limit in `MAGIC_LINK_NETWORK_RULES` and ADR 0025, keeping one
   network far below the pool edge.
