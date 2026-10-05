# 0044: recipient-hash key independent of the session-signing secret

Status: accepted (builder decision under the auth builder
final-cleanup prompt).

## Context

`recipient-key.ts`'s `deriveRecipientSubkey` derived a subkey from
`BETTER_AUTH_SECRET`, the same secret Better Auth uses to sign the session
cookie. `recipientKey` (that subkey plus the normalized address) is the
only form an email address takes in `email_suppression.recipient_hash`,
`email_delivery.recipient_hash`, and the per-recipient rate-limit bucket
keys (`rate-limit.ts`): the address itself is never stored.

`BETTER_AUTH_SECRET` is expected to rotate, routinely or on suspected
compromise (`docs/operations/secret-rotation-rehearsal.md`). Every rotation
changed the recipient subkey, so every existing suppression row's hash
stopped matching a lookup computed with the new one: the suppression check
silently stopped recognizing a hard-bounced or complained address, with
nothing in the application to show it happened, and every rate-limit
bucket reset to zero. Because only a hash is stored, no code path can
recompute a new hash from an old one without the plaintext address — the
address has to come from somewhere else (Resend's own suppression list, in
the operator runbook). That reconciliation is itself only a partial fix: a
bounce or complaint webhook that arrives after a rotation, for a message
sent before it, still resolves its recipient hash from
`email_delivery.recipient_hash` (stored at send time, under the old
subkey), so it would suppress the address under a hash the post-rotation
suppression check can never look up.

Found during a secret-rotation rehearsal review, out of scope for that
rehearsal.

## Decision

`recipientKey`'s subkey is derived from its own secret,
`RECIPIENT_HASH_SECRET` (`packages/config`'s `authFields`, same shape as
`BETTER_AUTH_SECRET`: 64 characters from 32 CSPRNG bytes), never from
`BETTER_AUTH_SECRET`. `deriveRecipientSubkey` itself is unchanged (it still
takes a secret and domain-separates it under the `recipient-key` label) —
only which secret feeds it changes, at the one composition site
(`server.ts`).

Consequences:

- A `BETTER_AUTH_SECRET` rotation (the cookie signature, and
  `client-ip.ts`'s `clientIdHash`) never desynchronizes the suppression
  ledger or the rate-limit buckets. This is a structural fix, not a
  reconciliation step: nothing needs to be re-keyed when
  `BETTER_AUTH_SECRET` rotates, and a bounce or complaint webhook received
  after such a rotation, for a message sent before it, still resolves to
  the same recipient hash the post-rotation suppression check looks up.
- `RECIPIENT_HASH_SECRET` is provisioned the same way as
  `BETTER_AUTH_SECRET` (`bun scripts/provision-auth-env.ts`, `.env.example`,
  the Fly staging secret set in `docs/operations/deploy-staging.md`), and
  is a required, non-optional auth field: a deployment cannot start without
  it, the same as `BETTER_AUTH_SECRET`.
- `RECIPIENT_HASH_SECRET` is expected to rotate far less often than
  `BETTER_AUTH_SECRET` — only on a suspected compromise of that specific
  value, never on a routine cadence — because rotating it still has the
  same reconciliation cost `BETTER_AUTH_SECRET` used to carry. The
  operator runbook (`docs/operations/secret-rotation-rehearsal.md`) moves
  that reconciliation procedure to `RECIPIENT_HASH_SECRET`'s own section.
- `client-ip.ts`'s `clientIdHash` stays derived from `BETTER_AUTH_SECRET`:
  log-correlation continuity across a rotation was never this decision's
  concern, and coupling it to `RECIPIENT_HASH_SECRET` instead would just
  move the same problem rather than remove it.

## Deployment: the one-time cutover

This decision introduces a new required secret into an environment that,
before it, had none: every `email_suppression.recipient_hash` and
`email_delivery.recipient_hash` row an already-deployed environment holds
was computed from `BETTER_AUTH_SECRET`. Introducing `RECIPIENT_HASH_SECRET`
is therefore not a routine deploy — it is exactly the same one-time
cutover a `BETTER_AUTH_SECRET` rotation always was, and it needs the same
two things a rotation needs: the secret staged first, and the ledger
accounted for.

**Deploy order is not optional.** `readAuthConfig` refuses to build the
auth configuration without `RECIPIENT_HASH_SECRET` (`Invalid auth
configuration: RECIPIENT_HASH_SECRET`), and `start.ts` reads
`app.auth().config` at boot, before the port opens. A deploy of this
change to any environment that does not already have `RECIPIENT_HASH_SECRET`
set fails closed at start-up — it cannot boot a build that silently drops
the ledger or the rate limit, only refuse to run at all. The secret must
be imported to that environment (`fly secrets import`, never a CLI
argument) **before** the deploy that carries this change, the same
prerequisite order `docs/operations/deploy-staging.md` step 5 already
establishes for every other required auth secret.

**Existing hashes are not recomputed — they cannot be.** No code path
ever stores the plaintext address behind a `recipient_hash`, by design
(this is the same property that makes the ledger safe to hold at all), so
there is no `oldHash → newHash` function: recomputing a hash under
`RECIPIENT_HASH_SECRET` requires the address itself, which has to come
from somewhere else. Two rows are affected differently:

- `email_suppression` is durable and security-relevant: a row here is the
  only record that an address hard-bounced or complained, and losing one
  silently means Offense Demo's own suppression check no longer refuses that
  address (Resend's own suppression list still blocks the send
  independently, per ADR 0025's original tradeoff note, but Offense Demo's own
  audit trail and any channel Resend's list does not cover are affected).
  Before or immediately after this cutover reaches an environment, an
  operator must do one of:
  1. **Reconcile**, using the same address-bearing source
     `secret-rotation-rehearsal.md`'s `RECIPIENT_HASH_SECRET` section
     already documents (Resend's `suppressions list` API, which holds the
     address `email_suppression` never does): compute each hash under the
     new `RECIPIENT_HASH_SECRET` and insert it, exactly as that runbook's
     script already does for an ordinary rotation of that secret.
  2. **Confirm nothing is lost**: if `select count(*) from
email_suppression` reads zero on that environment at cutover time,
     there is nothing to reconcile — record the count as the evidence.
     An owner-only task tracks completing this, with its count or reconciliation
     result, as an owner-only prerequisite leaf linked from the PR that
     introduces this change, completed before that PR merges.
- `email_delivery` is diagnostic-only, already pruned by the retention
  sweep 30 days after its last status change
  (`apps/web/src/server/retention-sweep.ts`), and carries no independent
  security consequence on its own (it is never consulted to decide
  whether to suppress a send; `email_suppression` is). A row keyed under
  the old subkey is left un-recomputed and simply ages out on its normal
  schedule — no reconciliation step applies to it.
