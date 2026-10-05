# 0025: authentication delivery and abuse protection

Status: accepted.

Stage 3 of passwordless authentication mounts Better Auth at `/api/auth/*` and
adds the delivery and abuse controls ADR 0020 requires before activation.

- **Scanner-safe links.** Emailed links open `/auth/confirm?token=…`, a
  server-rendered, no-store page with no script and no third-party or
  external asset (same-origin, fixed-path fonts are the one
  static load). `GET`/`HEAD` never redeem. Only
  an explicit same-origin `POST` forwards the token to Better Auth's
  `/magic-link/verify` through the mounted router (rate limits and origin
  checks apply), copies every `Set-Cookie`, and redirects `303` to a
  token-free, validated local path (default the signed-in home
  route, new users `/onboarding/username`). Expired or consumed links land on
  `/auth/confirm?error=INVALID_TOKEN`, which offers a user-initiated resend;
  nothing is ever sent automatically. Email-change links open
  `/auth/confirm-email?token=…` under the same rules. Every token follows
  the model below.
- **Emailed-link token model (owner decision, 2026-09-23).** This
  is the standard for every emailed link: sign-in, recovery, email change
  and every future type, such as invites. The link carries only an opaque
  token: 32 bytes from the OS CSPRNG, base64url (256 bits). No claims ride
  in the link. The server stores only `<purpose>:<SHA3-256 hex of the
token>` as the `verification.identifier`. The subject (the email for
  sign-in; the account, current address and new address for an email
  change) lives in `value`, with the expiry in `expires_at` (five minutes).
  The purpose prefix scopes the lookup, so a token redeems only in the
  flow it was issued for. Redemption goes through Better Auth's atomic
  `consumeVerificationValue`: one transaction per token under a consume
  lock. Exactly one caller wins, a lost race sees nothing, and an expired
  row is deleted without being honoured. Tokens are redeemed only by the
  same-origin `POST` confirm pages. The mounted router answers `404` to a
  direct request for either redemption endpoint (`/magic-link/verify`,
  `/email-change/verify`). Tokens are not bound to a device, so a
  link opened in another browser still works. Implementation:
  `apps/web/src/features/auth/emailed-link-token.ts`. Magic links use it
  through the plugin's `generateToken` and a `custom-hasher` `storeToken`.
  Better Auth's `'hashed'` option would be SHA-256. The recovery-email
  change is Offense Demo's `offense-demo-email-change` plugin
  (`email-change.ts`). Better Auth 1.7.5's own change-email flow signs a
  stateless JWT holding the addresses and the step, which can be neither
  stored nor revoked. The plugin replaces the core `changeEmail` endpoint
  under the same key and path, so the fresh-session gate, rate limit and
  lifecycle event keyed on `/change-email` still apply. It redeems both
  hops (old-inbox approval, then new-inbox verification) at
  `/email-change/verify`. It refuses a claim whose account no longer holds
  the old address. A new address that another account holds is never
  claimed: the approval hop mails its owner a notice instead of a
  verification link, and the verification hop refuses a claim whose new
  address was taken in the meantime (below).
  `/verify-email` and `/send-verification-email` are disabled. The only
  other value an emailed link carries is the sign-in link's requested
  local destination, which grants nothing: it is re-validated as a local
  path when the link is built and again on redemption. Email-change links
  carry no destination at all.
- **Residual risk: sign-up at a released address (owner decision, 2026-09-24).** Completing an email change deletes every
  outstanding sign-in link to the old address in the same transaction that
  moves the account (`completeEmailChange`). That delete sees only the links
  whose stored rows committed before its statement started. Such a link,
  redeemed after the change completes, creates no session and no account;
  an integration test proves it through the real confirm pages.
  Two interleavings around the instant the change commits remain open, and
  each can sign up a new, empty account at the released old address:
  - A link _requested_ while the change is committing: its row commits
    after the delete statement started but before the change commits, so
    the delete does not see it and it survives. Redeemed at any later time
    within its five-minute lifetime, it finds no account at the old address
    and signs one up (reproduced in a second-pass review).
  - A link _redeemed_ in that instant: Better Auth consumes a sign-in token
    before it looks the address up, so the lookup can land after the
    address switch, find the address already released and sign up there.

  The owner accepted the concurrent released-address sign-up as residual
  risk. That the acceptance also covers a link requested in the committing
  instant is a decision made on the owner's behalf, open until the owner
  confirms or overrules it. It is not a takeover: the changed account keeps its new address,
  sessions and data. And whoever holds the old inbox could sign up at that
  address anyway by requesting a fresh link.

- **An email change does not reveal whether the new address has an
  account.** `/change-email` never looks the new address up.
  After the suppression checks, every request stores an approval token and
  mails the same approval notice to the address on file, so a free and a
  taken new address get the same status, body and mail in the requester's
  inbox from the same work, provider send included, and the response time
  does not depend on the address. Before, a taken address answered at once
  and mailed nothing, which the requester could read from their own inbox
  and from the missing provider round trip. The taken case is settled at
  the approval hop, once the old inbox has approved: a free address is
  mailed the verification link, a taken one is mailed a notice
  (`email-change-taken`: someone asked to move another account to this
  address; it already belongs to your account, so nothing changed) whose
  one link points to the security settings and redeems nothing. That is how
  the owner of a taken address is told. Both approvals answer the same
  (`303` to the security settings, no cookie), so the requester learns
  nothing at that hop either: only the new inbox shows which mail came, and
  whoever reads it already knows whether it has an account. Both mails
  take the same delivery path and suppression refusal. The free path also
  stores the verification token, one indexed insert the taken path skips,
  which is accepted as noise beside the provider send both paths make. The
  verification hop still refuses a claim whose new address was taken
  meanwhile, so a taken address can never be claimed.
- **No session survives an email change it straddles.** A
  redemption whose lookup found the account _before_ the address switch is
  not in that window. Better Auth creates its session in a later statement,
  so the change's revoke-all could run first, and the session would then
  outlive the change on an account that no longer holds the address the
  link proved. After the session commits, an `after` hook on
  `/magic-link/verify` (`sign-in-address-guard.ts`) runs one statement
  (`revokeSessionUnlessAddressHeld`) that deletes it unless the account
  still holds that address, and answers as for a spent link. A change
  whose switch committed first is visible to that statement. One that
  commits later is followed by its revoke-all, which the insert's user-row
  lock orders after the session. So either the guard or the
  revoke-all removes it.
- **Rate limiting.** The ADR 0020 gate (`createRateLimitGate`, a Better Auth
  `hooks.before`; Better Auth's built-in limiter stays disabled) hands each
  bucket and its rule to the injected limiter. The Redis limiter runs one Lua
  `EVAL` in `@offense-demo/redis` (fixed window: INCR, arm expiry, decide). Keys are
  `<namespace>:v1:rl:<sha3-256 hex>`: identifiers are hashed and every key
  expires. Defaults are 100/60 s. Magic-link requests carry one client bucket
  (3/60 s), three per-recipient windows (3/60 s, 10/hour, 20/day — a single
  60 s window alone would still admit thousands of emails a day to one victim
  from rotating clients), and two whole-application ceilings independent of
  any client or recipient (120/60 s, 3,000/day — protects Resend quota, cost
  and sending-domain reputation from many recipients each staying under their
  own ceiling). Every magic-link send counts against the whole-application
  ceilings, but only a sign-up (a link to an address with no account) is
  held back by them, and they never refuse a request (see below). A limiter failure fails closed as a safe
  `503` (the route boundary adds `Retry-After: 5`); there is no
  process-local fallback and no allow-on-error. `429` carries `Retry-After`.
  The gate consumes a request's buckets in order (client, then recipients)
  and every consume counts, admitted or not, so a request denied by the
  recipient bucket has already spent its client budget. That is accepted:
  nothing is admitted wrongly, and spending nothing on denial would need one
  atomic multi-key script across every bucket. Integration tests prove the
  recipient hour and day ceilings and both global ceilings against real
  Redis.
- **Email-change mail ceilings for the new address.** An
  approved email change mails its new address: a verification link, or,
  when the address already has an account, the `email-change-taken` notice.
  `/change-email` meters that address with the same three
  recipient windows as a sign-in link (3/60 s, 10/hour, 20/day), in the
  same gate, under its own key
  (`auth:email-change:recipient:<recipient key>:<window>`), beside the
  per-client default (100/60 s). Without them, one account rotating client
  addresses could request and approve a change to someone else's address
  again and again and flood that inbox with notices, past the 20-a-day
  ceiling every other mail to an account has. The bucket is keyed on the
  address alone and the gate never looks the account up for this route, so
  a free and a taken address spend the same budget and get the same `429`:
  the ceiling reveals nothing about whether the address has an account. It
  is metered at the request, before any token or mail, because each
  admitted request leads to at most one mail to the new address (its
  approval redeems once). There is no global ceiling on this route: it
  needs a fresh session, and every mail it sends to a new address is capped
  by that address's windows. The email-change and sign-in windows are
  separate, so each flow caps its own mail. Their sum (up to 40 a day to
  one address) is accepted: a shared bucket would let a stranger's
  email-change requests spend an account's sign-in allowance. A stranger
  can also exhaust a free address's email-change allowance for the day,
  which delays a change to that address and nothing else. An integration
  test rotates client addresses and proves the day ceiling for a taken and
  a free address, with the same refusal for both.
- **Global sign-up ceilings and account existence.** Every magic-link send spends the
  whole-application ceilings, whether or not the address has an account.
  They are spent at the send (`sign-in-mail.ts`), after the rate-limit gate,
  the destination check and the suppression check have admitted the request
  exactly as they admit one for an existing account. With room, the link is
  sent to any address and the answer waits on delivery. Past a ceiling the
  request is answered at once, and everything that depends on the account
  runs after the answer (`after-response.ts`): the account lookup, then
  either the sign-in link's send to an existing account or, for a sign-up,
  the dropped mail and the deletion of its unmailed token. Only a sign-up is
  held back. Draining the ceilings alone never denies sign-in. The
  per-client buckets are per IPv4 address or per IPv6 /64 (Better Auth's
  `getIP` collapses an IPv6 client to its /64), and plus-addressed
  recipients (`victim+1@…`, `victim+2@…`) each get their own recipient
  buckets, so an attacker rotating the /64s of one /56 (256 of them, about
  12.8 magic-link requests a second at 3 a minute each) or one /48 (65,536,
  about 3,277 a second) slips past both; the aggregate network buckets
  below cap that. A drained ceiling only delays new sign-ups. A drained ceiling together
  with a flood past the handed-off work's bound (below) does stop sign-in
  mail: real sign-ins are shed with everything else until the flood ends
  (confirmed by the owner). Existing accounts' mail stays bounded by the
  recipient ceilings (20 a day per account). Sign-in links count toward the
  same 120 a minute and 3,000 a day, so a day's sign-up capacity is 3,000
  minus that day's magic-link sign-ins (passkey sign-in sends no mail and
  spends nothing). What the ceilings close: while one is saturated, an
  address with no account and an existing account's address get the same
  `200`, body and headers, with no `Retry-After`. The same holds
  when mail delivery also fails: a saturated request's answer never depends
  on delivery, so a failed sign-in send answers the dropped sign-up's `200`.
  With room, a failed send is the retryable `503` for both.
  The ceilings' remaining capacity is the same after either request, so a
  caller's own follow-up sign-up cannot read the answer back.
  The per-client and per-recipient buckets meter both alike, and their
  `429` is the same for both. Response time under saturation is the same
  for both: each answer waits on the same work (the gate's
  buckets, the suppression check, the token write and the ceiling spend)
  and on nothing that depends on the account, so the provider round trip
  of a real send is never part of it. The handed-off work is bounded:
  at most 512 tasks hold a slot at once
  (`AFTER_RESPONSE_MAX_RUNNING`) and at most 64 wait
  (`AFTER_RESPONSE_MAX_QUEUED`). A holder mostly waits on the provider or
  on the database gate, holding no connection, so the pool is sized by
  memory (under 5 MB) rather than by the database. Only the database steps
  (the account lookup, the suppression read and the one write) go through
  a gate of 4 (two-fifths of the 10-connection Postgres pool), whose own
  queue never exceeds the slot holders. A task arriving past both bounds
  is shed before it starts, so before the account lookup: the request has
  already had the same `200`, no lookup, send or drop runs, the token
  expires unused, and `auth.mail.shed` is logged with the backlog's size
  only and counted as `auth_mail_shed_total` on `/api/ops/metrics`. A flood
  that fills the bound sheds real sign-ins too: availability yields to a
  bounded backlog. Where the pool fills depends on the host and
  its load. On the development host (a steady flood of new addresses from
  rotating clients, a 300 ms provider, 10 real sign-ins spread through each
  run) it stayed far from full up to 700 a second at load about 300
  (nothing shed, 10 of 10 sign-ins mailed, as at 24 and 40 a second) and
  was full at 800 a second (3,573 shed, 3 of 10 mailed); at load about 10
  the review measured the edge at 1,000 to 1,200 a second. Production's
  `shared-cpu-1x` machine is unmeasured and will fill lower. Before the
  aggregate buckets, one /48 could send about 3,277 a second, past every
  one of those edges; the `mail_shed` alert reports a full pool.

  **Aggregate limits per network.** Every magic-link
  request also spends a bucket for its client's IPv6 /56 (30 a minute) and
  /48 (120 a minute), or its IPv4 /24 (120 a minute)
  (`MAGIC_LINK_NETWORK_RULES`, `rate-limit.ts`; the networks come from the
  trusted client address, `client-networks.ts`). They are atomic Redis
  buckets like the others, spent at the gate after the per-client bucket
  and before any account lookup, so a request over one is refused with the
  same `429` and `Retry-After` whatever the address. It is
  logged as `auth.rate_limit.network_denied` with the scope only, counted
  as `auth_rate_limit_network_denied_total{scope}` on `/api/ops/metrics`,
  and fires the `network_limited` alert past a sustained count (ADR 0042).
  The limits are sized against the pool edge: one /48 or /24 may send 2 a
  second and one /56 half a second, against an edge of 700 to 1,200 a
  second on the development host. The bound is against one /48 or /24,
  not against a distributed flood: no bucket sits above a /48, so the pool
  fills again once an attacker holds about (pool edge ÷ 2) networks each
  sending 2 a second. That is 350 to 600 networks at the low-load edge,
  and about 100 to 300 on a loaded host (a review measured
  300 IPv6 /48s at 503 a second filling the pool and mailing 1 of 10 real
  sign-ins). One IPv6 /40 is 256 /48s, about 512 a second, and one /32 is
  65,536 /48s, far past any edge; a botnet across a few hundred IPv4 /24s
  does the same. So the bar is one /40 to one /32, or a few hundred /24s,
  up from one /48 at about 3,277 a second. Past it, the `mail_shed` alert
  is the signal, and the shedding is the owner's accepted
  residual. A /56 is a typical household or
  small site, and a /48 or IPv4 /24 a typical organization, host or
  carrier NAT pool, so ordinary sign-in from one stays well inside them.
  Proven on the composed app at production bounds with real services
  (`auth-network-limits.integration.ts`): a flood from every /64 of one
  /48 at 3,250 a second for 10 s had 120 requests admitted and 32,650
  refused, the pool's occupancy peaked at 14, nothing was shed, and 10 of
  10 real sign-ins from outside the /48 were mailed. Without the aggregate
  buckets the same flood reached only 1,513 a second (every request doing
  full work), filled the pool (576), shed 31,967 and mailed 0 of 10. A
  /56 and a /24 are each capped at their own limit, and removing any one
  bucket turns its own flood red.

  **Residual: slot occupancy and account existence.** A real send holds its slot for a provider round trip; a
  dropped sign-up frees its slot in milliseconds. That difference is
  visible to another request only through shedding, and shedding happens
  only while the global ceiling is saturated and the whole occupancy pool
  (512 held, 64 waiting) is full. Then an attacker with their own
  existing account can request a target, request their own account just
  after, and read from whether their own link arrives whether the target
  had an account: with the pool exactly at its edge the effect is total
  (a one-slot pool gives 0 of 10 canaries mailed behind an existing target
  and 10 of 10 behind an unknown one, `auth-mail-ceiling-occupancy.integration.ts`).
  Under a real flood of 800 new addresses a second from rotating
  clients (248,207 requests over 200 canary trials a side, ABBA, a 300 ms
  provider), the pool was all or nothing: at the canary's moment its
  occupancy had a median of 1 and a 90th percentile of 575 (full). The
  canary was mailed 178 of 200 times behind an existing target and 181 of
  200 behind an unknown one: a difference of −1.5 points (95 % CI −7.4
  to +4.4, z −0.49), so the flood-held residual was not measurable at that
  sample size.
  So the attack needs a flood that holds the pool full (above the host's
  edge, which with the aggregate network buckets takes one IPv6 /40 or a few hundred /24s)
  for as long as it samples, timing that lands its probes in the moments
  the pool is full, many samples, and its own accounts; each probe of one
  target is also capped by the recipient windows (20 a day). The owner
  accepted this flood-only residual, which qualifies the earlier rule that
  account existence stays unobservable except through shedding
  once the occupancy pool is full. Two designs to close it were rejected.
  An equal-occupancy stand-in (a dropped sign-up holding its slot as long
  as a sampled real send) failed the power test: its holds matched within
  about half a millisecond, but at a sharp shed edge that still gave a 15
  to 20 point canary difference in 2 of 3 runs of 200 a side. A durable
  outbox for real sends leaks through the canary's delivery latency: a
  target's queued send delays the attacker's own mail. The handed-off
  work finishes before the app's pools close on shutdown, and a shutdown
  deadline that cuts it off logs `auth.mail.abandoned` with the count
  (fly.toml's `kill_timeout` outlasts that deadline). A database
  failure during the work is logged as `request.unhandled`, and its
  unmailed token expires unused. What stays
  observable: the account holder receives every sign-in link a prober
  requests, and sees it. Operators see saturation as `auth.rate_limit.denied` in the
  structured log, never in a response. A drained ceiling delays new
  sign-ups until its window resets: the person gets no mail and requests
  another link. A limiter failure on a ceiling fails closed with the same
  `503` as any other bucket. Integration tests against real Redis saturate
  the minute ceiling and prove identical answers, and run the canary probe
  (fill to 119 with the caller's own addresses, request the target, then
  one more own address), which is mailed alike whatever the target is. A
  latency test against real PostgreSQL and Redis, with the mail provider
  given a round trip, compares the two paths' response times with a
  two-sample Kolmogorov–Smirnov test (α = 0.001), and a unit test pins that
  both answer after the identical seam calls while the transport has not
  answered. Flood tests against real services (200 existing-account
  requests over 20 connections with the provider held and the bounds
  narrowed to 4 and 64, and 1,200 new-address requests over 1,000
  connections at the production bounds) prove the backlog never exceeds
  the bound and that the rest is shed and counted.

- **Suppression covers every auth mail.** Every auth email
  (sign-in links, email-change approval and confirmation, passkey
  added/removed notices) goes through the one delivery path
  (`send-mail.ts`), which checks the suppression ledger
  before anything reaches the transport. A suppressed recipient is logged
  as `auth.mail.suppressed` and nothing is sent. A mail the flow cannot
  proceed without (the sign-in link, the email-change approval to the
  current address, the confirmation to the new one) answers the same `422
EMAIL_UNDELIVERABLE` the sign-in gate does, except the email-change
  approval: the address on file cannot receive it, so a different new
  address would not help, and it answers `422 CURRENT_EMAIL_UNDELIVERABLE`.
  Both codes are defined once, in `undeliverable-codes.ts`. A passkey notice is
  best-effort, so the change it reports still completes. A ledger outage
  fails the send: required mail fails closed with the retryable `503`, and
  a notice logs `auth.passkey.notification_failed`. Two requests also check
  the ledger before any token is created or mail sent, through one shared
  check (`suppression-check.ts`): the sign-in gate, so a suppressed address
  leaves no stored link, and `/change-email` for both the new address
  and the address on file. Neither check depends on
  whether the new address has an account, so each `422` answers the same
  either way. An
  address suppressed after the request is still refused at the approval
  hop, where the confirm page says the new address cannot receive email and
  the person starts again with another address.
- **Trusted client identity — one resolver.** Better Auth's `advanced.ipAddress`
  is fixed to `{ ipAddressHeaders: [CLIENT_IP_HEADER] }`, the internal
  `x-offense-demo-client-ip` header, with no deployment-configurable header list and
  no `trustedProxies` option of its own — there is exactly one place client
  identity is resolved. The production ingress (`start.ts`) replaces any
  caller-supplied value with the socket peer, or — only when the peer is in
  `AUTH_TRUSTED_PROXIES` — the first untrusted hop from the right of
  `X-Forwarded-For`. The address is stamped in canonical form, with no
  zone id and any IPv4-embedding IPv6 form as its IPv4 address
  (`canonicalAddress`), so no two clients share a bucket
  through their notation. Beside it the ingress stamps `x-offense-demo-client-id-hash`, a
  SHA3-256 of the identity keyed by a subkey of `BETTER_AUTH_SECRET` (label
  `client-id-hash`). Request logs carry only that keyed hash: an unkeyed
  hash of an IPv4 address is reversed by hashing all 2^32 of them.
  `next dev` runs without that ingress, so a dev-mode request carries no
  such header and shares one "unknown" bucket per path,
  same as any other missing identity: a fail-safe bucket, never an escaped
  limit.
- **Origin rule.** State-changing `/api/auth/*` calls must carry the exact
  application `Origin`, in addition to Better Auth's own checks (which only
  engage for cookie-bearing requests). Callback destinations are local paths;
  external, protocol-relative and encoded forms are refused.
- **Mail.** Delivery goes through the injected sender seam. The Resend
  transport uses a ten-second total deadline, at most one retry of a transient
  failure under one idempotency key, and exposes only a generic retryable `503`
  (`EMAIL_DELIVERY_FAILED`). Open/click tracking is a Resend domain setting and
  must be disabled on the sending domain (human prerequisite).
- **Provider events.** `/api/webhooks/resend` verifies the raw body with the
  official Resend verifier (five-minute tolerance), deduplicates by event ID in
  PostgreSQL, and records only message/event IDs and a monotonic status rank.
  Recipients appear solely as a keyed SHA3-256 hash. Permanent bounces and
  complaints add a suppression that stops automatic resends with safe guidance
  (passkey or another address); events never create, verify or alter accounts.
- **Signature verification.** Webhook signatures are verified by the vendor
  (`resend.webhooks.verify`, standardwebhooks: HMAC-SHA256 with
  `timingSafeEqual`). This is a deliberate exception to the repo's SHA3-256
  comparison preference: Resend/Svix dictate the scheme, and a hand-rolled
  verifier would be worse.
- **Disclosure tradeoff.** A suppressed (hard-bounced or complained) address
  answers a distinct `422 EMAIL_UNDELIVERABLE`, revealing to any caller that
  the address bounced (not that an account exists); accepted for safe user
  guidance. `CURRENT_EMAIL_UNDELIVERABLE` tells a signed-in account holder
  only about their own address on file.
- **Verification retention.** Better Auth's `verification.value`
  holds the plaintext email JSON and Better Auth does not purge expired rows,
  so the server purges them itself: an in-process job (at start-up, then
  hourly) deletes rows expired more than 24 hours ago, at most 20 batches of
  500 per run
  (`DELETE … WHERE id IN (SELECT … LIMIT … FOR UPDATE SKIP LOCKED)` on the
  existing expiry index; no migration, no new service). Every instance runs it;
  concurrent runs split work without double deletes and live rows can never
  match the predicate. Shutdown stops the job between batches and waits for
  it before the pool closes. This job is one target of the
  web server's single retention sweep
  (`apps/web/src/server/retention-sweep.ts`), which also prunes
  `email_delivery_event` 30 days after receipt and `email_delivery` 30 days
  after its last status change (`email_suppression` is never pruned) and
  logs `retention.sweep.completed` (counts only) or `retention.sweep.failed`
  (stable code) per target. Session retention is a separate job.

Why: each control closes a distinct failure the spec names (link prefetch,
counter races and process-local limits, spoofed forwarding headers, provider
outages and bounce loops) using existing PostgreSQL and Redis only.

Tradeoffs: a fixed window admits up to twice the limit across a window
boundary; suppression is keyed to `RECIPIENT_HASH_SECRET`, independent of
`BETTER_AUTH_SECRET` since ADR 0044 — rotating that dedicated
secret still forgets suppressions (acceptable: the provider re-suppresses on
the next hard bounce), but a routine `BETTER_AUTH_SECRET` rotation no longer
does; the strict `Origin` requirement means non-browser API clients are
unsupported.
