# 0050: Local development prints auth mail to the terminal

Status: accepted (builder decision, 2026-10-05).

Number note: `bun adr:next` answered 0049, but the
[decision index](README.md#intentionally-absent-numbers) lists 0049 as
intentionally absent and not to be reused, so this record takes 0050.

## Context

Sign-in is passwordless: a magic link by email, then optionally a passkey.
`readAuthConfig` required `RESEND_API_KEY` and `AUTH_EMAIL_FROM` in every
environment, so a first-time user who ran the template locally without a
Resend account and a verified sender domain could not sign in at all. They
could not register a passkey either, because that needs a signed-in session.

The emailed link is a bearer credential: whoever holds it can sign in as the
recipient for five minutes. The repository rule is to never log
credentials, and the structured logger (pino, `@offense-demo/logger`) feeds log
shipping and alerting.

## Decision

1. **Selection is derived, never configured.** `readAuthConfig` returns
   `mailTransport: 'terminal'` only when all of these hold:
   `NODE_ENV=development`, both `RESEND_API_KEY` and `AUTH_EMAIL_FROM`
   are unset, and the hostname of `PUBLIC_APP_URL` is `localhost`,
   `127.0.0.1` or `[::1]`. Anything else needs both Resend fields, or the
   configuration is refused naming them. That covers `test`, `production`,
   any staging build (which runs as `production`), a development server on a
   hosted origin, and a half-configured Resend. No environment variable can
   select the terminal mailer, and a configured Resend key always wins.
2. **The terminal sender** (`apps/web/src/features/auth/terminal-mail.ts`)
   writes each auth email as a framed block whose every line starts with
   `[dev-mail]`. The block holds the recipient, the subject, each link in
   the message on its own `Link:` line, and the plain-text body. It writes
   to `process.stderr` directly, never through the structured logger, and
   strips terminal control characters. As a second check behind the
   configuration gate, it refuses to construct unless the validated server
   `NODE_ENV` is `development`.
3. **This is the one documented exception to "never log credentials".**
   It is limited to that module, writes only to the developer's own terminal,
   and covers only links minted on their own machine. The structured logs
   stay credential-free (a unit test checks that the token is absent from
   the recorded log events of a terminal-mailed sign-in).
4. **Bookkeeping matches a provider send.** The terminal sender goes behind
   the same `createSendMail` path. Suppression is checked first, so a
   suppressed recipient prints nothing. Rate limits and the global ceilings
   apply unchanged. The sender returns a local receipt (`dev-mail-<cuid2>`),
   so the `email_delivery` row is written as it would be for Resend, and
   `auth.mail.sent` is logged. No delivery webhook ever arrives for these
   rows, and the webhook route refuses to compose without a Resend key.

## Consequences

- `bun dev` works out of the box after `bun auth:provision` and
  `bun slot:up`. The developer clicks the `[dev-mail]` link in their
  terminal. Setting `RESEND_API_KEY` and `AUTH_EMAIL_FROM` switches to real
  delivery.
- A development server bound to a non-loopback `PUBLIC_APP_URL` (for
  example a deployed preview mistakenly run with `NODE_ENV=development`)
  still fails closed without Resend, so magic links never reach hosted logs.
- `AuthConfig` is a union on `mailTransport`. Code that needs the Resend
  credentials narrows on `mailTransport === 'resend'` first.
