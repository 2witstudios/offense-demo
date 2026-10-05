# Secret-rotation rehearsal

Staging-only rehearsal of planned and emergency (compromised) rotation for
`BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` and
`OPS_PROBE_TOKEN`, run against `offense-demo-staging` (2026-09-26 for the
first three, 2026-09-27 for `OPS_PROBE_TOKEN`). Every new value came from a
CSPRNG or the Resend API and was piped directly into `fly secrets import`
(`NAME=VALUE` over stdin — `fly secrets set` has no such flag, and a literal
value on the command line is itself a leak); no value was ever printed,
logged or pasted anywhere durable. This page shows only what "never log a
secret" allows: commands, digests-free evidence, counts and outcomes.

**Two Resend CLI commands print a secret in their own success output**:
`resend api-keys create` prints `token` and `resend webhooks get` prints
`signing_secret`. Both were hit once during this rehearsal (their output
briefly appeared in an operator terminal); each exposed credential was
revoked or rotated again within the same minute, before anything used it,
and the safe pattern below (`--json` output redirected straight to a file,
never the terminal, then piped to `fly secrets import`) avoids it going
forward. Operators must redirect `--json` output to a file for both
commands, never let it print, and prefer `resend webhooks rotate-signing-secret`
(no `get`) to read a webhook's current secret indirectly.

## Safe pattern

A shell redirect (`> file`) to a fixed, guessable path is two risks at
once: the file's permissions come from the operator's `umask` (typically
`022`, world-readable, so the token or signing secret sits world-readable
on disk until the `shred`), and a fixed path can already exist — including
as a symlink pointing somewhere the operator does not intend — so `>`
opens and truncates whatever it points to rather than a fresh file.
`mktemp` closes both: it atomically creates a brand-new, uniquely-named
file (refusing an existing path or a symlink) with owner-only (`0600`)
permissions already set, no `umask` needed:

```
bun -e 'console.log("BETTER_AUTH_SECRET=" + crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),""))' \
  | fly secrets import -a offense-demo-staging

key_file=$(mktemp)
resend api-keys create --name "<name>" --permission sending_access --domain-id <sending-domain-id> --json > "$key_file"
jq -r '"RESEND_API_KEY=" + .token' "$key_file" | fly secrets import -a offense-demo-staging
shred -u "$key_file" 2>/dev/null || rm -f "$key_file"   # shred doesn't exist on macOS

wh_file=$(mktemp)
resend webhooks rotate-signing-secret <id> --json > "$wh_file"
jq -r '"RESEND_WEBHOOK_SECRET=" + .signing_secret' "$wh_file" | fly secrets import -a offense-demo-staging
shred -u "$wh_file" 2>/dev/null || rm -f "$wh_file"
```

`fly secrets import` triggers the same rolling machine update as
`fly secrets set`, without ever taking the value as a CLI argument.
`--permission sending_access --domain-id <id>` (the app's own domain,
`offense-demo.com` on this account) scopes the replacement key to sending
mail from that domain only — the app never needs `full_access` (account
management, other domains, contacts, broadcasts), so a leaked
`RESEND_API_KEY` under this scope cannot do more than send mail from that
one domain, unlike the account's default `full_access` grant.

## BETTER_AUTH_SECRET

`server.ts` passes it straight to Better Auth as `secret`, which signs the
session cookie's value (`<token>.<hmac>`). Rotating it affects two things:

1. **The cookie signature.** `session` rows are untouched; only the HMAC
   stops verifying, so a pre-rotation cookie stops authenticating even
   though its row still exists.
2. **Client-id hash continuity in logs.** `client-ip.ts`'s `clientIdHash`
   derives from this same secret (`deriveSubkey(secret, 'client-id-hash')`);
   a rotation makes the same real client produce a different
   `clientIdHash` before and after, breaking log correlation across the
   boundary.

**The suppression ledger and per-recipient rate-limit buckets are
unaffected.** `recipient-key.ts`'s `deriveRecipientSubkey` keys `recipientKey`
from `RECIPIENT_HASH_SECRET` (ADR 0044), independent of this
secret — a `BETTER_AUTH_SECRET` rotation never touches
`email_suppression.recipient_hash` or a rate-limit bucket key. See
`RECIPIENT_HASH_SECRET`'s own section below for what actually needs
reconciling, and when.

**Verification links in flight survive a rotation.** `emailedLinkIdentifier`
(`emailed-link-token.ts`) hashes only the token itself (SHA3-256, unkeyed) —
`BETTER_AUTH_SECRET` never enters it — so a magic link or email-change link
issued before a rotation still redeems normally after it.

**Planned rotation** (executed): generated a fresh 32-byte CSPRNG value,
piped into `fly secrets import`. Fly rolled the one staging machine
(`stopped` → `started`, health `2/2`) in under a minute. Observed:

- A session cookie captured before rotation (`GET /api/auth/get-session`
  returned the session + user) now resolves `null` after rotation, same
  request, same cookie, HTTP 200 — Better Auth treats a bad signature as no
  session, not an error.
- A brand-new sign-in immediately after rotation redeems normally and gets
  a session cookie signed with the new secret — no window where sign-in
  itself is unavailable.
- `/api/health/ready` stayed `ready` throughout.

**Emergency (compromised) variant**: the rotation command is identical, but
a compromise response should not stop at the cookie signature — the
`session` rows themselves are unaffected by this rotation, so anyone who
captured a raw pre-rotation session token (not just an intact cookie) still
has a row that matches it. There is no application-level revoke-all for a
live database (`revokeOtherSessions` is per-user; `purgeAllForRestore`
itself deletes unconditionally — it is `scripts/post-restore-invalidate.ts`
that refuses by design outside an isolated restore copy, via
`restore-guard.ts`'s database-name and `current_database()` checks, before
ever calling it), so the emergency step
is a raw SQL delete, run as the Postgres superuser over the database
machine's own `fly ssh console` access — the same pattern this rehearsal's
Postgres access section uses throughout, so no connection string with a
password ever left the machine. `offense_demo_web` (the runtime role) also holds
`DELETE` on `session` and could run this same statement over its own
`DATABASE_URL` instead; the superuser path is documented here because it
is what this rehearsal actually ran, using access already open for the
restore rehearsal's own dump/restore steps. A `current_database()` guard
runs first, inside the same transaction as the delete — the guard and the
delete succeed or fail together, so a copy-pasted `-d` naming the wrong
database aborts the whole transaction before the delete ever commits, not
only when `ON_ERROR_STOP` happens to be set — this statement has no
`WHERE` clause, so a wrong target would otherwise revoke every session on
whatever database it landed on:

```
revoke_sql=$(mktemp)
cat > "$revoke_sql" <<'SQL'
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'offense_demo_staging' THEN
    RAISE EXCEPTION 'refusing: current_database() is %, not offense_demo_staging', current_database();
  END IF;
END $$;
DELETE FROM session;
COMMIT;
SQL
fly ssh console -a offense-demo-staging-db -C \
  "sh -c 'echo $(base64 < "$revoke_sql" | tr -d '\n') | base64 -d | PGPASSWORD=\"\$OPERATOR_PASSWORD\" psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d offense_demo_staging -f -'"
rm -f "$revoke_sql"
```

Staging: 4 sessions before, 0 after; `/api/health/live` and `/ready` stayed
healthy, and a fresh sign-in immediately afterward succeeded. This is raw
SQL, not `revokeOtherSessions`, so it never appends the `session.revoked`
outbox row that operation adds — a realtime instance watching for that
event is not notified. That is an accepted consequence of an emergency,
database-wide revoke, not a defect: the point is removing every session
row immediately, and no realtime consumer needs to react to a compromise
response the same way it reacts to a user's own sign-out.

**Recovery/rollback**: Fly secrets are write-only and the safe pattern above
pipes a fresh CSPRNG value straight into `fly secrets import` without ever
displaying, saving or logging it, so this runbook itself retains no copy of
the value a rotation replaced — there is no "roll back to the previous
secret" available from this procedure alone. A rotation done by mistake is
recovered the same way a compromise is: forward, never backward. If an
operator's own secrets manager independently holds the pre-rotation value
and wants it live again, that is a new rotation to that value, run through
the same safe pattern (piped in, never a CLI argument) — never a special
"rollback" path, since the identical mechanism that would restore a
mistaken rotation would just as easily hand a leaked secret its validity
back. There is exactly one direction: rotate forward to whichever value
should be current.

## RECIPIENT_HASH_SECRET

`recipient-key.ts`'s `deriveRecipientSubkey` derives a subkey from this
secret, and `recipientKey` (subkey + normalized email) is the only form an
address takes in `email_suppression.recipient_hash`, delivery receipts and
`createSuppressionCheck`'s lookup (`suppression-check.ts`), and the
per-recipient rate-limit bucket keys (`rate-limit.ts`). Unlike
`BETTER_AUTH_SECRET`, this secret is never rotated on a routine schedule —
ADR 0044 split it out from `BETTER_AUTH_SECRET` for exactly
this reason, so a routine session-secret rotation never touches it.
Rotating it at all (a suspected compromise of this specific value, never a
routine cadence) changes the subkey `recipientKey` derives: every existing
`email_suppression` row's hash stops matching a lookup computed with the
new subkey, and every rate-limit bucket resets to zero. This does not make
a suppressed address mailable in practice — Resend maintains its own
suppression list independently and blocks delivery to it regardless of
what our application decides — but the reconciliation below applies,
importing `RECIPIENT_HASH_SECRET` instead of `BETTER_AUTH_SECRET`:

Operator step: reconcile `email_suppression` to the new secret as part of
the same rotation, not as a separate later step — the value cannot be read
back from Fly once set (the safe pattern above pipes it there directly), so
reconciliation must run in the same session, from the same shell variable,
before that value is gone. `offense-demo-staging-db` has no external
endpoint (see the Postgres access section of `restore-rehearsal.md`), so
the hashes are computed locally (this needs the repo and the `resend` CLI)
and applied over `fly ssh console`, the same way that rehearsal reaches
Postgres; the hashes go in before `RECIPIENT_HASH_SECRET` is imported,
since they are inert under the old secret and importing first would
otherwise strand the new secret in Fly if reconciliation then failed. Save
this as a script and run it with `bash`, not an interactive shell — `zsh`
does not word-split the `--after` expansion below, so pagination past the
first page would send `resend` a malformed flag and it fails with `unknown
option '--after <id>'`:

```bash
#!/usr/bin/env bash
set -euo pipefail

new_secret=$(bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),""))')

subkey_reconcile() {
  echo "$new_secret" | bun -e '
    const { deriveRecipientSubkey, recipientKey } = await import("./apps/web/src/features/auth/recipient-key.ts");
    const secret = await new Promise((resolve) => {
      let data = "";
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data.trim()));
    });
    const subkey = deriveRecipientSubkey(secret);
    console.log(recipientKey(subkey, process.argv[1]));
  ' "$1"
}

remote_sql=$(mktemp)
trap 'rm -f "$remote_sql"' EXIT

sql_quote() { printf '%s' "$1" | sed "s/'/''/g"; }

printf 'SELECT count(*) AS suppression_rows_before FROM email_suppression;\n' > "$remote_sql"

cursor=""
while :; do
  page=$(resend suppressions list --limit 100 --json ${cursor:+--after "$cursor"})
  echo "$page" | jq -c '.data[] | select(.origin == "bounce" or .origin == "complaint")' | while read -r row; do
    email=$(echo "$row" | jq -r '.email')
    reason=$(echo "$row" | jq -r '.origin')
    source_id=$(echo "$row" | jq -r '.source_id // "reconciled-secret-rotation"')
    hash=$(subkey_reconcile "$email")
    printf "INSERT INTO email_suppression (recipient_hash, reason, provider_message_id) VALUES ('%s', '%s', '%s') ON CONFLICT (recipient_hash) DO NOTHING;\n" \
      "$(sql_quote "$hash")" "$(sql_quote "$reason")" "$(sql_quote "$source_id")" >> "$remote_sql"
  done
  has_more=$(echo "$page" | jq -r '.has_more')
  [ "$has_more" = "true" ] || break
  cursor=$(echo "$page" | jq -r '.data[-1].id')
done

printf 'SELECT count(*) AS suppression_rows_after FROM email_suppression;\n' >> "$remote_sql"

fly ssh console -a offense-demo-staging-db -C \
  "sh -c 'echo $(base64 < "$remote_sql" | tr -d '\n') | base64 -d | PGPASSWORD=\"\$OPERATOR_PASSWORD\" psql -v ON_ERROR_STOP=1 -h localhost -U postgres -d offense_demo_staging -f -'"

echo "RECIPIENT_HASH_SECRET=$new_secret" | fly secrets import -a offense-demo-staging
unset new_secret
```

The generated SQL is fed to `psql -f -` on standard input, one statement
per suppression row, each with `hash`, `reason` and `source_id` embedded as
SQL string literals with embedded `'` characters doubled (`sql_quote`) —
not left as raw interpolation. A `psql -c "... :'var' ..."` form looks
equivalent but psql does not perform variable substitution inside a `-c`
argument, so it fails with a syntax error at `:`; this only works fed on
standard input. The `trap` cleans up the temporary SQL file on any exit,
including a failed `fly ssh console` call under `set -e` — `shred`, used
elsewhere in this document, is not available on macOS, and this file holds
only already-hashed suppression rows and Resend message ids, never
`new_secret` itself, so a plain removal is enough. `psql -f -` prints the
bracketing `suppression_rows_before`/`suppression_rows_after` queries'
results to the operator's terminal as it runs — the row count itself,
never a hash or address, is the evidence this reconciliation records, the
same way the emergency session revoke above records a session count. Run
from the repository root (the `import` is relative to it).
`email_suppression.reason` accepts exactly Resend's `bounce`/`complaint`
origins (`manual` entries are excluded — they were never automatic, and
`email_suppression_reason_check` does not allow that value); `source_id`
is Resend's own originating message id, the real `provider_message_id`
this reconciliation would otherwise have no value for. `resend suppressions
list` pages at 100 per call and reports `has_more`; the loop above follows
every page, not only the first. The list is account-wide, not scoped to
this app's sending domain — this account also sends for other apps sharing
it, so reconciliation can insert a hash for an address Offense Demo never mailed.
That is over-suppression, never under-suppression, and costs nothing but
an unused row: safe to leave as a known imprecision rather than building
sender-scoped filtering the CLI does not offer.

**Recovery/rollback**: same shape as `BETTER_AUTH_SECRET` above — there is
nothing to roll back to; a rotation done by mistake is recovered the same
way a compromise is, forward, by reconciling again to whichever value
should be current.

## RESEND_API_KEY

Confirmed which of the account's four keys staging actually uses before
touching anything: `resend logs list`/`get` showed the `Bun/1.4.2`-agent
`/emails` POST (the raw-`fetch` sender `mail.ts` uses, not the Node SDK)
came from `offense-demo-app-sending`'s exact `last_used_at` timestamp — the
other three keys (`offense-demo`, the operator's own CLI key; `PageSpace`;
`Onboarding`, never used) were never touched.

**Planned rotation** (executed): create the replacement key, set it, verify
a send, then revoke the old one — old key stays valid until the new key is
already live, so sending never stops. The account's `api-keys create`
defaults to `full_access` (account-wide management), while the app only
ever sends mail, so the replacement key is `sending_access`, scoped to the
`offense-demo.com` domain id (the app's only sending domain) — a leaked key
under this scope can send mail from that domain and nothing else, never
manage other domains, contacts, broadcasts or keys:

1. `resend api-keys create --permission sending_access --domain-id
a6f552e6-fe5b-417a-8fb1-b16999e40469` (output to a fresh `mktemp` file) →
   `fly secrets import` → machine healthy.
2. `POST /api/auth/sign-in/magic-link` → `resend logs` shows a fresh `200`
   `/emails` POST signed with the new, scoped key.
3. `resend api-keys delete <old id>` → sent again → still `200`. Zero
   observed downtime.

**Emergency (compromised) variant** (executed): revoke the suspect key
_first_, accepting a gap, then replace it:

1. `resend api-keys delete <id>` on the active key.
2. Immediate sign-in attempt: `{"code":"EMAIL_DELIVERY_FAILED","message":"We
could not send the email. Please try again."}` — a real, observed outage
   window, unlike the planned path.
3. `resend api-keys create --permission sending_access --domain-id
a6f552e6-fe5b-417a-8fb1-b16999e40469` (same scope as the planned
   rotation — an emergency replacement is never broader) → `fly secrets
import` → sign-in succeeds again (`200`, confirmed against a second
   recipient address after the first hit the per-recipient rate limit —
   the abuse protection working as intended,
   not a rotation defect).

**Recovery/rollback**: a revoked Resend key cannot be un-revoked; recovery
is always "create another key", never "restore the old one". Keep the
outage window to the time between revoke and the next `fly secrets import`
— there is no way to shorten it further from this side, since Resend
revocation is immediate and irreversible by design.

## RESEND_WEBHOOK_SECRET

`resend webhooks rotate-signing-secret <id> --help` documents Resend's own
grace window: "for 24 hours, payloads are signed with both the new and the
previous secret" — that is Resend's outbound behavior (every delivery in
that window carries a signature for each secret), not anything our side
needs to hold both secrets for. Our verifier
(`apps/web/src/features/auth/webhook.ts`, `resend.webhooks.verify({ ...,
webhookSecret: secret })`) checks against exactly the one `secret` value
`RESEND_WEBHOOK_SECRET` currently holds — never a list, never both old and
new. Two consequences follow:

- **Real deliveries never break across a rotation.** Because Resend signs
  every delivery in the 24h window with both secrets, whichever one secret
  our app currently holds, the payload always carries a matching signature.
- **A forged request signed only with the leaked old secret is rejected
  immediately** once `fly secrets import` lands the new secret — our
  verifier has already forgotten the old one, and Resend's dual-signing is
  a property of its own outbound deliveries, not something an attacker
  holding only the old secret can reproduce for a request they send us
  directly.

**Use `rotate-signing-secret` + `fly secrets import` for both the planned
and the emergency case.** The single-secret verifier above means this is
already the immediate response to a leak: the old secret stops working the
moment the import lands, with no 24-hour exposure window to wait out and no
need to touch the webhook endpoint at all.

**Planned rotation** (executed): `rotate-signing-secret` on the existing
webhook id (endpoint URL unchanged) → `fly secrets import` → machine
healthy. A subsequent sign-in produced an `auth.mail.webhook` /
`http.request.completed` log line at `status:200` within seconds —
verification against the new secret succeeds.

**Never delete and recreate the webhook to rotate its secret.** Reserve
delete+recreate for the one case `rotate-signing-secret` cannot cover: the
endpoint URL itself must change. Deleting and recreating the same endpoint
URL, observed on this rehearsal: the recreated endpoint delivered no event
for several minutes despite `resend webhooks get` showing `status:
enabled` and `resend emails get` showing the underlying sends reached
`last_event: "sent"` — rotating the secret again on the same, already-
established endpoint id delivered within seconds on the next send by
contrast. Delete+recreate is therefore not a same-second recovery the way
`rotate-signing-secret` is, and there is no CLI signal (`status`, `get`)
that distinguishes "still recovering" from "broken."

**Recovery/rollback**: once the 24-hour grace window from a rotation has
elapsed, the previous secret no longer verifies anything — there is nothing
to roll back to. A wrong new secret set in `RESEND_WEBHOOK_SECRET` is fixed
by rotating again and re-importing, not by trying to recover the old value.

## OPS_PROBE_TOKEN

`requireProbeToken` (`apps/web/src/features/ops/probe-auth.ts`) compares a
SHA3-256 digest of the request's bearer token against a digest of exactly
the one `OPS_PROBE_TOKEN` value the app currently holds — the same
single-secret shape as `RESEND_WEBHOOK_SECRET` above, never a list, so a
rotation's new value takes effect and forgets the old one the moment it
lands, with no grace window. It gates `/api/ops/alerts` and
`/api/ops/metrics`; the scheduled `auth-alerts.yml` workflow is its only
caller, authenticating with the value GitHub holds as the
`OPS_PROBE_TOKEN` repository secret — so, unlike the other three secrets in
this document, a rotation has two destinations that must carry the
identical value, or the workflow starts sending a token the app no longer
accepts.

**Rotate both from one generated value, in the same shell session, planned
or emergency alike — there is no revoke step and no separate emergency
variant, the same as `RESEND_WEBHOOK_SECRET`'s single-secret case:**

```
new_probe_token="$(bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),""))')"
echo "OPS_PROBE_TOKEN=$new_probe_token" | fly secrets import -a offense-demo-staging
echo -n "$new_probe_token" | gh secret set OPS_PROBE_TOKEN
unset new_probe_token
```

**Executed**: rotated for real against `offense-demo-staging` and its
`OPS_PROBE_TOKEN` GitHub repository secret. Immediately after import, a
direct request with the new value (`curl -H "Authorization: Bearer
<new_probe_token>" https://offense-demo-staging.fly.dev/api/ops/alerts`)
returned `200`; the same request with an arbitrary wrong token returned
`401`. The old value was never captured, so it was never separately sent —
that it too now fails is an inference from `requireProbeToken`'s
single-digest comparison above, not a second observation.

**Recovery/rollback**: same shape as `RESEND_WEBHOOK_SECRET` — the safe
pattern never retains the previous value and Fly cannot return it, so there
is nothing to roll back to. A wrong value in either destination is fixed by
rotating again, generating one new value and re-setting both, never by
trying to recover the old one.

## End-of-rehearsal state

- `offense-demo-app-sending`: a fresh key, `sending_access` scoped to the
  `offense-demo.com` domain id (every earlier `full_access` replacement
  created during this rehearsal was revoked); `offense-demo` (operator CLI),
  `PageSpace` and `Onboarding` untouched.
- The webhook: same endpoint URL and event subscriptions as before the
  rehearsal, current secret matches `RESEND_WEBHOOK_SECRET`.
- `BETTER_AUTH_SECRET`: rotated once from its pre-rehearsal value; every
  session created before this rehearsal no longer authenticates (expected —
  the synthetic seed's sessions from `restore-rehearsal.md` are among them).
- `email_suppression`: 0 rows on `offense_demo_staging` at the time of this
  rotation (`select count(*) from email_suppression;`), so no reconciliation
  step was exercised against staging during this rehearsal — the rotation
  happened before `RECIPIENT_HASH_SECRET` existed (ADR 0044),
  and staging had nothing to reconcile in any case. `BETTER_AUTH_SECRET`
  rotations from now on never touch `email_suppression`; the reconciliation
  step is documented under `RECIPIENT_HASH_SECRET` above, for the (rare)
  case that secret itself is ever rotated once the ledger holds real rows.
- `OPS_PROBE_TOKEN`: rotated once from its pre-rehearsal value on both Fly
  and the `OPS_PROBE_TOKEN` GitHub repository secret; a request bearing the
  new value against `/api/ops/alerts` returned `200`, an arbitrary wrong
  value returned `401`.
- Verified before finishing: `GET /api/health/live` → `alive`,
  `GET /api/health/ready` → `ready`,
  `bun scripts/staging-security-probe.ts --url https://offense-demo-staging.fly.dev`
  all `PASS` except the documented `NOT RUN` (needs a signed-in probe, a
  known probe limitation, not caused by this rehearsal), and a fresh
  sign-in by email succeeds end to end.
