# Privacy

Offense Demo is pre-ship and US-first, built GDPR-ready. This document is the
operator-facing guide to classification, retention, data subject rights,
consent and subprocessors. The rules themselves live in
[ADR 0036](../decisions/0036-privacy-by-design.md) (classification,
inventory, retention, erasure, consent) and
[ADR 0037](../decisions/0037-error-tracking-and-product-analytics.md)
(Sentry and PostHog); this page never restates a rule the ADRs already own,
it only points at the mechanism and answers "where do I look".

## Classification

Every field, column, Redis key and vendor-held record carries a category —
`none | identifier | personal | sensitive | secret` — and, when `personal`,
a visibility — `public | private`. See ADR 0036 §1 for the full definitions
and the `users.username` / `users.email` worked examples. `personal`,
`sensitive` and `secret` values never reach a log line, an error report or
an analytics event, whatever a `personal` value's visibility. The outbox
and every realtime topic payload are classified surfaces, not telemetry:
every field rides only once it is declared in the inventory below. Once
classified, a `personal`/`public` value such as a display name may ride
one; `personal`/`private`, `sensitive` and `secret` values never appear in
either.

Identifiers are scoped per telemetry surface — logs, errors, analytics —
never global; ADR 0036 §2 is the source of truth for which identifier a
given surface may carry.

## The personal-data inventory

`packages/db/src/schema/data-inventory.ts` will be the single declaration
of every `table.column`'s category, visibility, purpose, lawful basis,
storage (`postgres | redis | vendor`), owner, retention, erasure rule and
exportability, per ADR 0036 §3, once it is built. Redis key
namespaces and vendor-held records (the PostHog person, Sentry user
context: `personal`/`private`, storage `vendor`) will be classified in the same inventory, not a separate one.

**Until the inventory exists:** the file above does not exist yet, so a
personal-data column, log field, `outbox.payload` kind or realtime topic
payload field carries its classification (category, visibility, purpose,
lawful basis, retention, erasure) in the PR body instead, per the "Privacy
& telemetry" section of `.github/pull_request_template.md`. `bun privacy`
(planned) will then fail the build on an unclassified column, a
stale entry, or a personal column missing `visibility`, `storage`,
`owner`, `retention` or `erasure`, and will name the owning area in every
failure; it is planned to run as part of `bun check` and the CI matrix
once it lands, and will carry the PR-body entries into the inventory.
Adding a column that holds personal data will get its own recipe in
`docs/development/extending.md` at the same time.

**`outbox.payload` and every realtime topic are classified surfaces under
these same rules, not an exception.** `outbox.payload`
(`packages/db/src/schema/outbox.ts`) is an untyped JSON column — its only
storage is the `outbox` row (`storage: postgres`); realtime delivery from
it is transient in-process fan-out inside `apps/realtime` (ADR 0031) and
needs no separate storage entry — and two different exposure surfaces ride
it (`packages/protocol/src/realtime-payloads.ts`):

- **Delivered to a subscribed browser** (the delivery-side rule, added to
  `@offense-demo/protocol` with the first `event` sender): the `room.changed`
  doorbell on `room` (ids, `kind` and `version` only, category
  `identifier`/`none`; the browser refetches the state it is allowed to
  read over HTTP) and `user.notification-delivered` on `user:inbox`, which
  also carries `notificationType` (a controlled vocabulary string, category
  `none` — never free text) and `occurredAt` (a timestamp, category
  `none`); neither is personal, but both still need their own inventory
  entry.
- **Storage-only, never delivered as an `event` to any client**
  (storable through `isPayloadStorableOnTopic` only): the three `user:inbox`
  control kinds (`session.revoked`, `access.revoked`,
  `user.presence-preference-changed`), each an array of ids only. These
  are durable rows the realtime service consumes internally to close
  sockets or re-project presence; they never ride a subscribed topic as an
  `event` message, so their exposure is narrower than the delivered kinds
  above, not equivalent to them.

Both surfaces still need inventory entries — the point of this section is
that neither is an exemption, delivered or storage-only. Any payload kind
made storable (`isPayloadStorableOnTopic`) or deliverable (the delivery-side rule) must
classify every one of its fields the same way a database column would
before it can ride a topic: a `personal`/`public` value is allowed once
classified; a `personal`/`private`, `sensitive` or `secret` value never is.

## Retention

Retention today is scattered across a few ADRs and one doc, until the
inventory becomes the single index:

- [ADR 0025](../decisions/0025-auth-delivery-and-abuse-protection.md) and
  [docs/operations/auth-delivery.md](auth-delivery.md): expired
  `verification` rows are purged after 24 hours; `email_delivery` and
  `email_delivery_event` rows hold only keyed recipient hashes and IDs and
  are purged after 30 days; `email_suppression` rows are kept so a
  suppression survives an account. One retention sweep
  (`apps/web/src/server/retention-sweep.ts`) owns all of these.
- [ADR 0036](../decisions/0036-privacy-by-design.md): account deletion
  tombstones the user (below). Domain records that reference a user are
  retained only when they hold no personal fields; each domain table states
  its own retention in the inventory.
- **Sessions**: an expired `session` row (`ip_address` and `user_agent`
  travel with it) is purged 24 hours after `expires_at`, the same grace and
  the same sweep as `verification`. A revoked session is deleted
  immediately by the revoking operation (`revokeOtherSessions`,
  `revokeSessionUnlessAddressHeld`) and is never seen by the sweep; neither
  path ever logs `ip_address`, `user_agent` or a token.
- **Operational logs**: every process writes structured
  JSON to stdout only ([observability](observability.md)); no log shipper
  or second store is configured, so Fly.io's platform log search is the
  only place they persist, and it
  [retains app logs for 7 days](https://docs.fly.io/monitoring/logging-overview/).
  Operational logs are kept no longer than 30 days: that is a ceiling,
  not a minimum. Fly's 7-day
  log search satisfies it, and no log shipper is added. Any log drain or
  shipper added later must keep its retention at or under 30 days and
  record it here.

## Data subject rights

Export and erasure are planned as pure planners driven by the inventory
(`exportPersonalData(principal)`, `erasePersonalData(principal)` in a
`features/privacy/` area of `apps/web`); an adapter executes each plan in
one transaction.

**Export** returns every exportable inventory column for the requesting
principal, and nothing for any other principal.

**Erasure** runs the ADR 0036 §4 tombstone transaction: private personal
data is deleted, public personal data is scrubbed per its own inventory
entry (today `delete` — `users.username` is set `NULL`, matching
`users_tombstone_scrubbed`, not replaced with a placeholder), the auth rows
are deleted, grants are revoked and `deleted_at` is set. Domain rows that
reference the user and hold no personal fields stay, pointing at the
tombstone. In the same transaction, one `privacy_jobs` row is inserted per
vendor currently configured (none, if no vendor key is set). After commit,
a worker retries each vendor deletion with backoff until the vendor
acknowledges (ADR 0036 §4); a vendor outage never blocks or reverts the
local erasure that already committed. A job that keeps failing past a
threshold emits a registered log event, so an unfulfilled vendor deletion
is never silently lost.

## Consent

`necessary`, `analytics` and `replay` always exist in the stored consent
schema, independent of which vendors are configured in a given deployment
(ADR 0036 §5). `unanswered` counts as denied everywhere a decision is
needed. The UI shows only the categories backed by functionality actually
enabled in the running deployment, and asks again only for a category that
becomes enabled later and that the user left unanswered — an earlier
answer is never reset. A signed-in user's choices are additionally recorded
in `consent_record` (version, choices, timestamp) as durable proof of
consent.

## Subprocessors

| Subprocessor     | Purpose                                                       | Data                                                                                                          | Region                                 | DPA status          |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------- |
| Sentry           | Error tracking (ADR 0037)                                     | Scrubbed error events; `user.id` (cuid2) only, no PII                                                         | Deploy-time host/DSN setting           | Human-only sign-off |
| PostHog          | Product analytics and consent-gated session replay (ADR 0037) | Event properties classified `none`/`identifier` only; `anonymousId` or `userId`                               | Deploy-time `NEXT_PUBLIC_POSTHOG_HOST` | Human-only sign-off |
| Resend           | Transactional auth email delivery (ADR 0025)                  | Recipient email (delivery only); webhook events retain a keyed SHA3-256 recipient hash, never the raw address | Configured at the sending domain       | Human-only sign-off |
| Hosting provider | Application hosting                                           | Whatever the deployment platform's own subprocessor terms cover                                               | Deploy-time                            | Human-only sign-off |

Vendor account creation, region choice, DPA execution and deploy secrets are
a human-only sign-off leaf; no agent self-approves them.

## DPA checklist

Before a subprocessor goes live in a real deployment:

- [ ] Vendor account created under the organization, not a personal login.
- [ ] Data processing region confirmed and recorded against this table.
- [ ] DPA (or equivalent data processing terms) executed and filed.
- [ ] Deploy secrets (`SENTRY_DSN`, `POSTHOG_API_KEY`, etc.) set only in the
      deployment platform's secret store, never committed.
- [ ] Sentry source-map upload configured, without a token that needs a
      broader scope than source-map write.
- [ ] Subprocessor row above updated with the confirmed region and DPA
      status.

## What is not built yet

Export and erasure, the inventory and its `bun privacy` gate are planned,
not built. Plan them as an epic on the drive (see `AGENTS.md`). This
document describes the rules that work implements, not its current
implementation status.
