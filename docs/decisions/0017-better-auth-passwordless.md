# 0017: Better Auth passwordless authentication boundaries

Status: accepted. Amended by owner decision, 2026-09-23. Every
emailed link follows the opaque, SHA3-256-stored, single-use token model in
[ADR 0025](0025-auth-delivery-and-abuse-protection.md). Better Auth's
JWT-based email verification (`/verify-email`,
`/send-verification-email`) is disabled. The recovery-email change runs on
Offense Demo's `offense-demo-email-change` plugin instead of the core `changeEmail`
flow.

Offense Demo adopts Better Auth, pinned to `1.7.5` together with
`@better-auth/passkey` and `@better-auth/drizzle-adapter` at the same version,
for email magic-link and passkey authentication over the existing PostgreSQL
database. Passwords, OAuth, and password reset stay disabled. The version is
verified against the npm registry before installation and re-verified against
the version-matched official documentation before each implementation stage.

Ownership follows the repository edges. `apps/web` owns all Better Auth
configuration and application orchestration: the server composition lives in
`apps/web/src/features/auth/`, and `apps/web/src/lib/` is reserved for narrow
composition entrypoints — they exist only when a real consumer imports them,
and feature behavior lives under `features/auth`, never in `lib`. The React
client entrypoint `apps/web/src/lib/auth-client.ts`, the server composition
in the app's composition root (`apps/web/src/server/app.ts`), and the
`/api/auth` route handler at
`apps/web/src/app/api/auth/[...all]/route.ts` all exist and `authClient` is
wired into the sign-in, onboarding, session-refresh, and security-settings
UI. `packages/auth`
remains the framework-free Principal/Permission vocabulary and must never
import Better Auth, Next, React, Drizzle, or Bun APIs; trusted authentication
adapters resolve into its `Principal` contract. `packages/db` constructs the
Drizzle auth adapter around its existing Bun SQL pool and exposes only an
opaque adapter capability through its public API; raw Drizzle and Bun SQL
access stays private to `db`. Rate limiting consumes the existing
`@offense-demo/redis` client; the auth seam never opens a second SQL or Redis pool.

The server auth instance is created through a lazy, resource-injected factory
(`createAuthServer`) that accepts the database adapter, an email sender, a
rate limiter, a logger, and the injected application clock and identity
generator. Configuration (`BETTER_AUTH_SECRET`, `RECIPIENT_HASH_SECRET` since ADR 0044,
`PUBLIC_APP_URL`, `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, and the optional
`AUTH_TRUSTED_PROXIES` list) is validated server-side at factory call
time through `@offense-demo/config`, reporting field names only; importing modules
requires no credentials and dials no service. Email delivery goes through an
injected `send` function (Resend in production, captured or failing senders in
tests), so builds and unit suites never require live mail. Resend
credentials and sender DNS are human-provisioned prerequisites; implementation
stages proceed against injected senders without claiming live delivery.

Better Auth owns the WebAuthn challenges, sessions and the atomic
verification-row consume. Offense Demo owns the emailed-link token format: its
entropy, its SHA3-256 storage digest and the purpose it is bound to. This
is the one place Offense Demo replaces a Better Auth flow. The library's
change-email tokens are signed JWTs that are never stored, so they can be
neither revoked nor redeemed only once, and no option switches them to
stored tokens.

Why: Better Auth supplies maintained WebAuthn/passkey and magic-link flows
instead of handmade cryptography, while the pinning, adapter ownership, and
lazy factory keep the framework at the delivery edge — the domain, protocol,
and `packages/auth` contracts stay extraction-ready, tests stay deterministic,
and baseline startup is unaffected until authentication activates.

Tradeoffs: a version-pinned third-party framework in the security-critical
path (audited at every upgrade, never patched through custom forks), and a
thin indirection (factory plus injected senders) that pays for itself in
testability and in the human-owned provisioning boundary.
