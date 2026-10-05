# 0036: Privacy by design

Status: accepted. Extends [ADR 0019](0019-token-secret-ownership.md) (what
must never be logged) and the account tombstone transaction, which this
ADR's erasure planner drives. Amended by
[ADR 0037](0037-error-tracking-and-product-analytics.md) for the vendor
surfaces this ADR's classification applies to.

Adapted for the template from the project it was extracted from.

## Context

Offense Demo is pre-ship (ADR 0023): every log field, database column and future
analytics event is still cheap to classify. Retrofitting privacy after
rows and dashboards exist is not. Today nothing stops a call site from
logging an email address, no column declares whether it holds personal
data, and there is no inventory, no consent model and no data-subject-rights
mechanism. The 2026-09-22 external review of the privacy spec added seven
points, all incorporated below: visibility on personal data, identifiers
scoped per telemetry surface, a non-recursive undeclared-field path, storage
and owner on every inventory entry, a durable vendor-erasure outbox, a
consent schema independent of deploy configuration, and this ADR's
`errorClass` rule (mechanism in ADR 0037).

The rule this ADR exists to enforce: every privacy rule is a **type, a
registry or a gate**, never a checklist held in someone's memory. AGENTS.md
and the PR template only point at those mechanisms; they never restate the
rules themselves.

## Decision

### 1. Data classification

Every field and column carries a **category**, one of `none | identifier |
personal | sensitive | secret`:

- `identifier`: cuid2 ids. Pseudonymous on their own.
- `personal`: email, username, name, image, IP, user agent.
- `sensitive`: GDPR special categories. None exist today; adding one needs
  its own ADR.
- `secret`: tokens, keys and hashes of secrets.

A `personal` entry also carries a **visibility**:

- `public`: shown to other users as profile identity (username, display
  name, image, and later any public profile field). Erasure is `delete` or `anonymize` per the column's own
  entry — `anonymize` where a stable, non-identifying placeholder keeps
  history readable, `delete` where the existing schema clears the value
  outright.
- `private`: seen only by the subject and the system (email, IP, user
  agent, consent choices). Usually deleted on erasure.

Worked examples: `users.username` is personal/public, purpose "public
profile identity", erasure `delete` — the `users_tombstone_scrubbed`
CHECK requires `username IS NULL` on a tombstoned row, not a placeholder,
so `anonymize` would misdescribe the already-merged schema. `users.email`
is personal/private, purpose "authentication", erasure `delete`.

`none` and `identifier` never require a visibility. `personal`, `sensitive`
and `secret` values never reach a log line, an error report or an analytics
event, whatever the `personal` value's visibility — `packages/logger`'s
`loggableFields` allowlist enforces this by restricting which field names
and kinds may appear in a log call at all; a `path` or `route` field's
value must be a route pattern (e.g. `/profile/[username]`), never a
concrete URL, so a personal value cannot ride through it either (the
allowlist does not yet enforce that shape; closing that gap is tracked
work).
The adapters in ADR 0037 are the mechanism for errors and analytics.

This ban is on the three named surfaces, not on every persisted or
transmitted representation: the outbox (`outbox.payload`) and every
realtime topic payload are classified surfaces (§3), not telemetry — every
field rides only once it is declared in the inventory, the same as a
database column. Once classified, a `personal`/`public` value such as a
display name may legitimately ride one; a `personal`/`private` value never
may, and `sensitive` and `secret` values never appear in either regardless
of classification. The payload's only storage is the `outbox` row
(`storage: postgres`); realtime delivery is transient in-process fan-out
inside `apps/realtime` (ADR 0031) and needs no separate storage entry.

### 2. Identifiers are scoped per telemetry surface, not global

A stable id is pseudonymous only inside the surface it was issued for; nothing
lets one surface's id become a cross-context tracking key. Each surface
declares its own closed field vocabulary for identifiers:

- **Logs:** `requestId`, `traceId`, and optionally `userId`.
- **Errors (Sentry):** `requestId`, and optionally `userId`. An error
  report is diagnostic, never a product record.
- **Analytics (PostHog):** exactly one of `anonymousId` (pre-sign-in or
  no identify consent) or `userId`. Nothing links an anonymous id to a user id except
  PostHog's own `identify` at sign-in, and only under analytics consent.

The types enforce this per surface; a field outside a surface's vocabulary
fails typecheck there even if another surface allows it.

### 3. The personal-data inventory

Every `table.column` (and every Redis key namespace and vendor-held record)
is declared once, with all of:

- `category` and, when `personal`, `visibility`
- `purpose`
- `lawfulBasis`
- `storage`: `postgres | redis | vendor`
- `owner`: a closed union (`auth | realtime | telemetry | privacy | …`)
  that grows with each feature area, so a gate failure names who is
  responsible
- `retention`: `{ kind: 'account-lifetime' | 'ttl' | 'legal', ms? }`
- `erasure`: `delete | anonymize | cascade | tombstone | retain`
- `exportable`

An entry with no matching column is stale and fails the gate; a column
missing from the inventory, or a `personal` entry missing `visibility`,
`retention`, `erasure`, `storage` or `owner`, fails the gate. This closes
gap 1 in the spec: `outbox.payload` (an untyped JSON column) and every
realtime topic family (`room`, `room:presence`, `room:chat`,
`user:inbox`, `packages/protocol/src/topics.ts`) are
classified surfaces under §1's rule, not an exception to it — a
`personal`/`public` value may ride one once classified; `personal`/`private`,
`sensitive` and `secret` values never may. Whether a given payload kind is
delivered to a browser (the delivery-side rule) or stored only for the
realtime service's own internal use (`isPayloadStorableOnTopic`), it
classifies every field before it may exist (see [privacy](../operations/privacy.md)
for the current split).

The registry and its gate (`bun privacy`, planned) are the mechanism; this
ADR fixes the shape the gate enforces.

### 4. Data subject rights

Export and erasure are pure planners driven by the inventory; an adapter
executes each plan in one transaction. Local erasure is atomic and reuses
the account tombstone transaction: scrub private personal data, scrub
public personal data per its own entry's erasure rule (today `delete`,
matching `users_tombstone_scrubbed`'s `IS NULL` requirement — see §1),
delete the auth rows, revoke grants, set
`deleted_at`, and leave the `users` row as a scrubbed tombstone so rows
that reference it keep a valid key.

**References to a tombstoned account are retained.** A product table
that records history against a user (`created_by_user_id` and the like)
keeps pointing at the tombstone: the cuid2 id is an `identifier`, not
personal data, and the row it points at no longer holds any. Each such
column still gets its own inventory entry with erasure `retain`; a column
that holds personal data of its own follows its own entry instead.

**Vendor erasure is durable and asynchronous, never inline with local
erasure.** In the same local-erasure transaction, one `privacy_jobs` row is
inserted per configured vendor (`id`, `subject_ref` — the tombstoned user's
surviving cuid2 id, the key the vendors hold — `vendor`, `operation`,
`status: pending | succeeded | failed`, `attempts`, `last_error_class`,
`created_at`, `completed_at`). After commit, a worker retries each job with
backoff until the vendor acknowledges. A vendor outage never rolls back
local erasure, and a deletion request is never lost. `privacy_jobs` is not
a general job framework: it records durable deletion intent only, it is
itself classified in the inventory, and a succeeded row carries a TTL.
Jobs that keep failing past a threshold emit a registered log event so an
incident is never silent.

### 5. Consent

Three categories always exist in the stored schema — `necessary` (always
on, no consent needed), `analytics`, `replay` — independent of which are
wired up in a given deployment. Each is `granted | denied | unanswered`,
and `unanswered` is treated as denied everywhere a decision is needed. The
UI shows only the categories backed by functionality actually enabled in
the current deployment; when a category becomes enabled later, the banner
asks again only for that unanswered category and never resets an earlier
choice. A signed-in user's choice is also written to a `consent_record` row
(version, choices, timestamp), itself classified in the inventory as
personal/private.

Keeping the stored schema fixed regardless of deploy configuration is
deliberate: a consent record must mean the same thing whether or not a
vendor key happens to be set that day, or a later audit cannot tell what a
user actually agreed to from what the deployment happened to expose.

## Consequences

- The logger work implements the closed per-event log field types this ADR's surface
  scoping requires, plus the non-recursive undeclared-field violation path
  (`internalTelemetryViolation`, reachable only outside `log()`, so
  `telemetry.undeclared_field` itself can never recurse).
- The inventory work implements `packages/db/src/schema/data-inventory.ts` and the
  `bun privacy` gate, classifies every current column, and wires the gate
  into `check`, `ci.yml` and `scripts/evidence.ts`.
- The data-rights work implements `exportPersonalData`, `erasePersonalData`, the
  `privacy_jobs` table and migration, and the retry worker.
- The analytics work implements the product event registry, the consent banner and
  `consent_record` migration against this ADR's consent model.
- `docs/operations/privacy.md` is the operator-facing document; this ADR is
  the rule it points at, not a duplicate of it.
- Any new `sensitive` category needs its own ADR before a column or field
  may use it; none exists today.

## Sources

- GDPR special categories of personal data (Article 9):
  https://gdpr-info.eu/art-9-gdpr/
- Data subject rights to erasure and to access (Articles 15, 17):
  https://gdpr-info.eu/art-15-gdpr/, https://gdpr-info.eu/art-17-gdpr/
