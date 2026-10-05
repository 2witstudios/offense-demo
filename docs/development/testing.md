# Testing

Four tiers, all runnable locally. Faster tiers must not require slower
infrastructure. All unit tests follow TDD and the RITEway format (ADR 0014);
`packages/domain/src/project.test.ts` (the template's placeholder domain
suite) is the canonical example. Generic
AIDD/Vitest guidance is overridden here by Bun and RITEway (ADR 0021).

## Tiers

1. **Unit/domain (`bun test`)** — every package's `src/`. Domain, protocol,
   config, errors, logger, observability, and web HTTP-boundary tests are
   deterministic and need no services, no Next boot, no network.
2. **Integration (`bun test:integration`)** — real PostgreSQL and Redis via
   Compose, plus the web vertical exercised through actual route handlers
   (validation, principal, domain, persistence, error mapping). Requires `bun slot:up`, which migrates this checkout's test
   database. Suites are discovered, not listed: each workspace's
   `test:integration` runs `scripts/test-integration.ts`, which runs every
   `integration/**/*.integration.ts`. The root `bun test:integration` runs
   one workspace at a time (`--concurrency=1`) to bound load on the shared
   stack; every run has a database of its own (below), so workspaces cannot
   interfere through rows or triggers. A suite that
   drains the outbox, or triggers a drain with the poll switched off, first
   waits for its row with `waitForOutboxFinality` (`@offense-demo/db/testing`):
   `pg_snapshot_xmin` is cluster-wide, so on the shared local stack another
   checkout's open transaction holds a committed row back (ADR
   0032 §1).
   **Test Redis (ADR 0034).** Each slot's suites write to their own
   Redis database (`TEST_REDIS_URL`; a worktree's is `2 + its port block`).
   Name a suite's namespace with `testNamespace(createId())` from
   `@offense-demo/redis/testing`, so it is a `t3-` namespace the runner can sweep, and
   open Redis only with `openTestRedis(url)`, which returns a frozen wrapper
   (no constructor, no raw client behind it) that allows a fixed set of
   commands and scans only under one test namespace (every `MATCH` of a `SCAN`
   must be anchored there); lint refuses any `RedisClient` or `redis` import
   from `bun` in an integration file. Hand code under test a client from
   `createBoundedTestClient(url)`: no key it writes is immortal or outlives two
   hours. `scripts/test-integration.ts`
   removes stale `t3-` namespaces before a workspace's suites start (idle over
   an hour) and fails the run, naming the keys, if any key has no expiry
   afterwards. `bun proof:test-redis` proves the isolation and the
   killed-run cleanup against a throwaway Redis.
   **Test Postgres (ADR 0034).** Every run of a workspace's suites
   gets a database of its own, made and migrated by
   `scripts/test-integration.ts` and dropped after the run, so a killed run
   cannot leave rows behind; the next run drops the database of any run whose
   runner is gone. Suites take `TEST_DATABASE_URL` from `requireTestServices`,
   which accepts only that per-run database: `bun test` on a suite file is
   refused. To run one suite, from its workspace:
   `bun --env-file=../../.env ../../scripts/test-integration.ts integration/x.integration.ts`.
   `bun proof:test-postgres` proves the SIGKILL cleanup against this
   checkout's slot.
3. **Browser E2E (`bun test:e2e`)** — Playwright boots the **production**
   server (`e2e/support/server.ts` wrapping `src/server/start.ts`,
   `NODE_ENV=production`) with production-refined configuration. The
   wrapper adds only a loopback TLS edge (a per-run self-signed certificate,
   so the public origin is HTTPS and Secure session cookies work; the
   Chromium projects launch with `--ignore-certificate-errors`, because
   `ignoreHTTPSErrors` alone restarts every request on a new connection and
   a burst of them can drop the page CSS) and a
   capture of the outbound Resend call; tokens, users and sessions are made
   by the real handlers, and nothing under `src/` imports the wrapper. Specs
   for account-only pages sign up through those handlers
   (`e2e/support/accounts.ts`); the sign-in journey itself is driven through
   the real `/sign-in` UI (`e2e/journey.e2e.ts`). The suite asserts route shells, metadata titles, security
   headers, correlation IDs, health/readiness, and 404 behavior. The driver runs under Node 24; config
   and specs live in `apps/web`. The production-refined configuration runs
   as the `offense_demo_e2e` login, a member of the `offense_demo_web` runtime role with
   no grant of its own (ADR 0038), against this checkout's own e2e
   database, never the test database whose row counts integration evidence
   reads, and in its own Redis database and namespace:
   `E2E_DATABASE_URL`, `E2E_REDIS_URL` and `E2E_REDIS_NAMESPACE`, which
   `bun slot:up` writes (CI sets them in `e2e.yml`). `bun slot:reset-e2e`
   empties that database back to the baseline. A missing value makes the server refuse to start rather than
   fall back to another checkout's data.
4. **CI parity** — `bun check` approximates the CI checks job (format, lint,
   policy, knip, duplication, invariants, evidence, typecheck, unit tests, metrics policy,
   production build). CI additionally runs the
   integration tier with service containers and the browser tier in the
   dedicated `e2e.yml` workflow (one E2E owner per PR; `bun evidence`
   fails if a second workflow also runs `test:e2e`). `bun verify` runs those additional gates locally and also applies
   the committed migrations twice to `TEST_DATABASE_URL` to prove reruns are
   idempotent.
   - **Stage logs.** `bun verify` streams each stage's stdout and stderr,
     interleaved, into `verify-logs/<stage>.log` as they are written, and
     prints the last 40 lines of any stage that fails, so a failure is never
     reported without its cause.
   - **Failed browser runs.** Playwright empties `apps/web/test-results` at
     the start of every run, so when the e2e stage fails, `bun verify` copies
     that folder to `verify-logs/e2e-failures/<UTC time>-<commit>/` and names
     the copy in the e2e gate's detail. It holds each failed test's trace,
     screenshot and video (`retain-on-failure`) and the production server's
     and realtime's logs (`server-<port>.log`, `realtime-<port>.log`). No
     later run writes there; delete old folders by hand.
   - **Docs-only diffs.** For a diff against `origin/main` (untracked files
     included) that touches only Markdown under `docs/`, ADRs included, it
     skips the browser tier and reports
     `SKIP e2e: skipped: documentation-only diff (N files)`.
   - **Machine-wide e2e limit.** `apps/web`'s `test:e2e` runs Playwright
     through `scripts/e2e-limit.ts`, a limit on concurrent browser runs across
     every checkout on the machine (`OFFENSE_DEMO_E2E_CONCURRENCY`, default 2), with
     one slot directory for all of them (`/tmp/offense-demo-e2e-slots`, or
     `OFFENSE_DEMO_E2E_LOCK_DIR`). Runs beyond it wait in a queue instead of
     saturating the CPU.
   - **Lint timeout.** `eslint.config.test.ts` shares one ESLint instance and
     runs with `--timeout 180000`. The first typed lint took 5.7 s at load 56,
     and Bun's fixed 5 s default failed it.

### Release qualification (`bun test:e2e:qualify`)

The single-run `test:e2e` in the PR/push workflow proves the suite passes
once; it is not release proof by itself. Before opening a release PR (or as a
manual/scheduled job, never as an additional required PR check — that would
triple E2E wall-clock time on every push), run `bun test:e2e:qualify`. It
runs the complete Playwright suite three consecutive times with retries
disabled (the standing config), saves each run's JSON report under
`apps/web/qualification-results/run-{1,2,3}.json` plus a `summary.json` —
deliberately outside `apps/web/test-results`, which Playwright clears at
the start of every invocation and would otherwise erase each prior run's
report before the next one starts — and fails if any of the three runs has
a failure or an empty test selection.
A retry-pass or a single green run is not this gate; all three outcomes are
retained as artifacts.

### Multi-instance load and outage proof

Cross-instance correctness (shared sessions, passkey challenges, one-time
token consumption, username uniqueness) and outage/restart recovery
(instance restart, database outage, Redis outage, Resend timeout) are
deterministic proofs in the integration tier:
`apps/web/integration/auth-cross-instance.integration.ts` and
`apps/web/integration/auth-outage-recovery.integration.ts` (the latter uses
`fault-proxy.ts`, a pausable TCP relay standing in for the shared local
stack, which ADR 0034 forbids stopping or reconfiguring). Throughput,
latency and the shipped 80/10/10 workload mix are proven separately by
`apps/web/scripts/auth-load/` — two real production instances behind one
shared TLS edge, run manually or by an operator, never part of `bun check`
or `bun verify` (it needs a production build and takes minutes to hours
depending on the requested duration). See its README for local usage and
the staging go-ahead gate.

## Suite wiring (`bun evidence`)

A suite that nothing invokes is indistinguishable from a suite that does
not exist — PageSpace lost entire tiers this way. `bun evidence` (in
`bun check` and CI) is the live audit:

- Every `*.test.ts` and `*.test.tsx` must sit in a claimed location: a
  workspace's `src/` (`bun test src`, the unit tier), root `scripts/`
  (`bun test scripts`, the root-script tier), or the root eslint config
  test (`bun lint`). Anything else is an ORPHAN_SUITE.
- Every `integration/` suite must be run by its workspace's
  `test:integration` script (the discovery runner claims the whole folder)
  and must import `requireTestServices` from `@offense-demo/config` and call it on
  `process.env` in a top-level statement (`requireTestServices(process.env);`
  or `const … = requireTestServices(process.env);`). It **throws** when
  `TEST_DATABASE_URL` (ending in `_test`) or `TEST_REDIS_URL` is missing, so
  the file fails instead of skipping. The gate reads the parsed import and
  call, not text: a hand-written guard, a mention in a comment, a call
  deferred into a test body, or one behind an `if`, a `try`, a short-circuit
  or an optional call is GUARD_MISSING.
- Every `*.e2e.ts` is claimed by the Playwright config, and exactly one
  workflow runs `test:e2e`.
- `bun test src` globs only `*.test.ts(x)`, and Playwright matches only
  `*.e2e.ts` under `apps/web/e2e/`. A `*.integration.ts(x)` or
  `*.e2e.ts(x)` under `src/`, and any `*.e2e.tsx`, is recognized as a
  suite but executed by no runner, so it fails as ORPHAN_SUITE.
- The `knip`, `policy`, `duplication`, `invariants`, `evidence`, and `migrations:check` gates must
  appear in `ci.yml`, so deleting a job breaks CI instead of silently
  retiring a gate.
- `bun policy` scans repository-owned source for direct UUID generation and UUID
  contracts. Only exact, documented entries in `policy/exceptions.json` can
  allow framework, tooling, migration, or integration-isolation uses. Every
  exception must link an existing ADR and include a future-or-today ISO
  `reviewBy` date; missing, expired, duplicate, or nonexistent-path entries
  fail the gate.

## Rules

- **TDD.** Write the failing test first (red), make it pass (green), then
  refactor. New behavior lands with its tests in the same change. Never
  skip, disable or weaken a test to get green; a flaky test is a bug.
- **RITEway format.** Tests import `describe`, `test`, `assert` and
  `setupRitewayBun` from `riteway/bun` (9.3.0, the Bun-native entry point),
  call `setupRitewayBun()` once per file, and assert value contracts with
  `assert({ given, should, actual, expected })`. An expected `AppError` is
  asserted with `assertRejects({ given, should, actual, code })` from
  `@offense-demo/errors/testing`, which checks the factory-minted code (and
  `invariantId`) of a throw or a rejection, so a stray `TypeError` fails;
  `rejectionOf` reports the same outcome as a value. Other exception paths
  use `bun:test`'s `toThrow(message)` or the exact error, never a bare
  `.toThrow()` (ESLint rejects one). `scripts/check-boundaries.ts` (in
  `bun lint`) admits an `@offense-demo/*/testing` or `*.test-support` import only
  from suites, `integration/`, `e2e/` and test support, never production
  source. Schema
  tests assert the parsed value or the issue paths, not a `.success`
  boolean. `given`/`should` read as a specification sentence:
  when the assertion fails, its message is the bug report.
- **Dead code.** `bun run knip` fails on unused files, exports and
  dependencies; keep findings at zero (ADR 0013).
- **Duplication.** `bun run duplication` fails on any copy-pasted block not
  in `.jscpd-baseline.json`, and on any copy-pasted test block not in
  `.jscpd-tests-baseline.json` (tests have their own scan and baseline);
  consolidate instead of re-baselining (ADR 0026).
- Tests are deterministic: inject clocks/IDs; never sleep-and-hope; no
  cross-test shared state; use deterministic unit IDs and CSPRNG isolation IDs
  only in real-service integration tests; clean only records you created.
  The runner enforces it: `scripts/test-integration.ts` counts every table
  in the run's database before and after a workspace's run and fails the
  run, naming the table, when any table ends with more rows than it started
  with. Leaked rows pile up run over run and slow every later run until a
  hook times out. `createTestApp` removes its accounts, its
  Redis namespace (one `UNLINK` per `SCAN` page) and every delivery,
  webhook-event and suppression row keyed by its mailbox's message ids.
  Wait on the state under test, never a timing window: fire a Redis expiry
  with `PEXPIREAT` (the redis `withRedis` fixture's `expireNow`) instead of
  waiting out a TTL, read lease scores against the Redis server clock,
  resolve on the LISTEN callback, and release a lock holder once
  `pg_locks` shows the waiter. An expiry Better Auth stamps is read as
  `expires_at - created_at` from the row, not against the runner's clock.
- Integration tests read `TEST_DATABASE_URL` (must end in `_test`) and
  `TEST_REDIS_URL`; never point them at development or production data.
  Missing services hard-fail (`throw`), never skip.
- No test skips, `console` noise, or relaxed strictness to force green.
  Flaky tests are bugs.
- New domain behavior lands with domain tests first; new durable behavior
  lands with an integration test through the application operation, not by
  mocking the database.
- The web integration suites share one fixture module,
  `apps/web/integration/fixtures.ts`: the test environment, the app, the
  accounts a suite creates (`fixtureEmail`), their cleanup (`removeAccount`,
  keyed by email and user id) and their row counts (`counts`). Every suite
  builds its own app with its `createTestApp`: `createApp` over the test
  services with its own validated environment, Redis namespace, mailbox
  `fetch`, log output and client addresses, and the route handlers
  `createRoutes` builds from it. Suites share one `bun test` process, so a
  test never writes `process.env` or `globalThis` (ESLint refuses it) and
  passes regardless of which suites ran first. Mounted-route auth suites
  (`auth-*.integration.ts`) drive the real `/api/auth/[...all]`,
  `/auth/confirm` and `/api/webhooks/resend` handlers against real PostgreSQL
  and Redis. Only the outbound mail transport is replaced (the suite's
  mailbox captures the production Resend sender's HTTP call); tokens, users,
  sessions, limits and cookies are all real. Concurrency claims use real
  simultaneous requests, and every safeguard has a sabotage control recorded in
  the PR (remove it → the named test fails).
- Auth work follows route gate → Principal resolution → authorization → atomic
  rate limit. A limiter outage must use the operation's documented safe failure
  behavior; tests must cover the outage path before route activation.
- Playwright config env demonstrates the full production-refined
  configuration; keep it that way so e2e failures catch config regressions.

### Cross-browser and accessibility coverage

`chromium` runs the whole functional suite (dashboard chrome, theme, CSP,
auth) and stays the primary CI project. Cross-browser and
mobile-layout parity is scoped to the auth journeys the spec requires
("the supported magic-link/account journeys"), not the whole app:
`chromium-mobile`, `firefox`, `webkit` and `webkit-mobile` testMatch only
`AUTH_JOURNEY_SPECS` (journey, onboarding, form-transport, passkey-lifecycle,
accessibility, auth-routes)
in `apps/web/playwright.config.ts`, plus `passkey-autofill.e2e.ts` for
`chromium-mobile`. CDP WebAuthn (the virtual authenticator
behind every passkey ceremony) is Chromium-only, so
`passkey-lifecycle.e2e.ts` is additionally excluded from every non-Chromium
project; a spec that needs a Chromium-only WebAuthn capability belongs in
that file or `passkey-autofill.e2e.ts`, not in `journey.e2e.ts`. The
sign-in page arms passkey autofill (conditional mediation). Chromium's
virtual authenticator answers that request with no pick, so button specs
either call `withoutPasskeyAutofill` or hold user presence
(`setPresence(false)` in `e2e/support/webauthn.ts`) while autofill arms,
releasing it only for the button's own request. A request sent while
presence is held never completes, even after presence returns. The same
behaviour makes `passkey-autofill.e2e.ts` the autofill proof in both
Chromium projects. `apps/web/e2e/accessibility.e2e.ts` runs
`@axe-core/playwright` against every auth screen (sign-in idle/pending,
onboarding, the passkey offer in both themes, settings/security, an expired
link), asserting zero
serious/critical findings, plus a 200%-effective-zoom reflow check; its
sibling `accessibility-keyboard.e2e.ts` covers keyboard-only navigation,
visible focus and a live-region assertion (halving the viewport, the
standard technique since Playwright has no native browser-zoom control).
Real-device rows (Safari/iOS, Chrome/Android, a roaming security key) are
owner-recorded pre-release evidence, never emulated; see the review record
for the exact NOT RUN rows and what to capture.

## Styling safeguards and visual parity

Styling is token-locked Tailwind v4 (ADR 0028). Every rule fails
`bun check`, and each has a negative fixture proving it fires:

- **Lint** (`eslint-plugin-better-tailwindcss`, fixtures in
  `eslint.config.test.ts`): arbitrary values and properties (`[` in a
  class), unknown or default-theme classes, conflicting classes, duplicate
  classes, `dark:` and `scheme-*` variants.
- **Format**: `prettier-plugin-tailwindcss` sorts classes, so
  `bun format:check` fails on an unsorted class list.
- **Repository gate** (`scripts/check-styling.ts`): no `*.module.css` and no
  `tailwind.config.*` file anywhere.
- **Policy** (`bun policy`): no inline `style` attribute or `<style>`
  element in TSX and no silenced Tailwind lint rule, unless a registry
  exception links an ADR.
- **Theme** (`apps/web/src/app/theme.test.ts`): compiles the real
  `globals.css` and proves default utilities generate no CSS while token
  utilities resolve through the custom properties.

### Visual parity

The Playwright config ships a `visual` project that runs
`apps/web/e2e/visual.e2e.ts` and compares full-page screenshots with
`apps/web/e2e/visual-baselines/`. The template ships the wiring, not the
spec: add `visual.e2e.ts` once the product has screens worth pinning (dark
and light, at 1440, 1024 and 390 px wide is the established pattern). Baselines are Linux-only: fonts
render differently elsewhere. CI runs on Linux natively. On any other host
the `visual` Playwright project is excluded until a Linux browser is
provided:

```sh
bun visual:server                     # Linux Playwright image, port 43400
PW_WS_ENDPOINT=ws://127.0.0.1:43400/ bun test:e2e
```

To regenerate after an intended visual change, run the same command with
`--update-snapshots` appended to the Playwright invocation
(`node node_modules/@playwright/test/cli.js test --project=visual
--update-snapshots` from `apps/web`, with `PW_WS_ENDPOINT` set), review the
image diff, and record the before/after on the plan. `bun visual:server`
runs `scripts/visual-server.ts`, which takes the image tag and run-server
version from the web app's exact `@playwright/test` pin, so they always
match. The
command lives in a script because Bun rewrites `npx` in a `package.json`
script to `bun x`, which the image lacks.

## UI component tests

UI under `apps/web/src/ui/` is Tier 1: tests sit next to the component as
`<name>.test.tsx`, render with `react-dom/server`'s `renderToString`, and
assert behavior (landmarks, accessible names, link targets, store-driven
content) rather than markup snapshots. No DOM library is installed or needed.
`bun test src` runs them, and `bun evidence` counts them in the unit tier
and orphan-checks them like any `*.test.ts` suite.

- Styling is Tailwind utilities written in the markup (ADR 0028), so
  `renderToString` output contains the literal classes. Variant props (button
  variant, badge tone, avatar size, tile tint, presence) are pure functions
  from props to a class string in `<name>-class.ts`; test them with RITEway
  by asserting the literal classes for every variant. Do not assert on
  stylesheet text.
- Store-driven components read the module-level store: call
  `setUiState({ ...createInitialState(), … })` at the start of each test so
  no test depends on another's state.
- `next/link`, `next/image`, and `usePathname` render under plain
  `react-dom/server` (`usePathname` returns `null`).
- **The `.render.tsx` split.** When a component needs client hooks or the
  store but its markup deserves direct tests, split it: `<name>.tsx` is the
  `'use client'` shell that reads hooks and passes plain props and void
  callbacks; `<name>.render.tsx` exports a pure `render<Name>(props)`
  function with no hooks. The pure half gets the unit tests
  (`<name>.render.test.tsx`), including callbacks, which can be invoked
  straight off the returned element's props. `nav-item` and `search-input`
  are the examples. Do not split components that render fine as-is.
- **Effect extraction.** `useEffect` never runs under `react-dom/server`, so
  a component whose only work is an effect keeps a thin shell and moves the
  write into a pure function that takes its DOM target as a parameter; the
  test passes a plain recording object. When the side effects need an
  order, put them in a controller that takes them as injected functions.
  `ui/theme/apply-theme.ts` and `ui/theme/theme-controller.ts` (used by
  `theme-provider.tsx`) are the example.

### Page creation and stall evidence

Every spec imports `test` from `apps/web/e2e/support/fixtures.ts`, and every
page, the test's own and any second device or tab, opens through its
`openPage(context, purpose)`. ESLint rejects Playwright's own `test` (by
name, namespace, default, re-export or dynamic import) and any direct
`newPage` outside that module. `openPage` bounds page creation at 15 s, so a
browser that never answers fails by name instead of as a bare 30 s test
timeout. Before it throws, it writes `stall-evidence.log` to the test's
output folder within a 3 s budget (a process listing or log read that does
not finish in time is cut and says so), naming the layer that
stopped:

- **browser**: Playwright sent the page-creation command
  (`Target.createTarget`, `Playwright.createPage` or `Browser.newPage`) and
  the browser never answered it, never attached the new page, or never
  answered a command to the new page's own session (the one its attach
  event opened). Another page's command still in flight never counts
  . The log lists what the browser still answered meanwhile;
- **driver**: Playwright's own event loop stalled for a second or more (the
  bound's timer fired late), so it could not read an answer, or every
  command was answered and `newPage` still did not resolve;
- our **server**'s event loop in the same window: `e2e/support/server.ts`
  logs one `e2e.event_loop` sample a second to `server-<port>.log`, and a
  starved or stopped server writes none.

The log also carries the protocol messages in the window, up to the moment
the bound fired and tagged by session, the host's load,
the worker's browser processes with their scheduler state (`T` is stopped)
and the server log's lines for the window. A failed test also keeps
`protocol.log`, its protocol traffic reduced to direction, id, method and
session handles (never parameters, so no cookie or credential).
`e2e/stall-evidence.e2e.ts` proves each verdict live: it freezes the browser
with `SIGSTOP`, starves the driver, and starves the capture itself (a
process listing that never returns), and each must be named within its
budget.

### Known limits of the browser harness

- A rare page-creation stall (about 1 in 600 page
  setups in the heavy suites under load, 0 in 5,000 bare setups in review)
  is not reproduced on demand, and its cause is unverified. One capture
  exists: the new page's session never answered while the
  browser session did. Protocol traffic cannot tell a renderer that never
  started from one that hung or a stalled helper process. Each further stall
  leaves `stall-evidence.log` for diagnosis.
- The host line's `os.freemem` excludes inactive and cached memory on
  macOS, so a figure of about 130 MiB there is routine, not memory pressure.
- The protocol capture reads the `debug` instance playwright-core exports
  as `playwright-core/lib/utilsBundle`, an untyped export. `playwright-core`
  is pinned to the same version as `@playwright/test`; an upgrade must keep
  `stall-evidence.e2e.ts` green, which fails if the capture records nothing.
- While a test runs, the fixture owns the `pw:protocol` namespace;
  `DEBUG=pw:protocol` still prints, and other `pw:*` namespaces are untouched.
- The server evidence covers the web process (app, TLS edge and mail
  capture); `apps/realtime` is not sampled, since no page creation reaches it.
- On macOS, Playwright's WebKit follows the system keyboard setting: unless
  "Keyboard navigation" is on (System Settings → Keyboard, the
  `AppleKeyboardUIMode` default), Tab moves only between text fields and
  lists, never to buttons or links. The specs that Tab to a button or link
  then fail in `webkit` and `webkit-mobile` only, with `toBeFocused`
  receiving "inactive" or fewer focused controls than expected:
  `accessibility-keyboard.e2e.ts` (username onboarding by keyboard, visible
  focus on every sign-in control, the shared-computer decline) and
  `journey-no-js.e2e.ts` (the username form's keyboard decline). They pass
  on Linux CI and on a Mac with that setting on; this is the host, not the
  app. `bun cli/verify-generated.ts --e2e` runs Chromium and Firefox only
  for this reason.

## Test file naming

New packages name their suite `src/index.test.ts`. Existing subject-named
suites (`errors.test.ts`, `protocol.test.ts`, `auth.test.ts`,
`project.test.ts`) stay as they are; do not rename them. App and UI tests are
named after the file they specify.

## CI Artifacts

The Browser E2E workflow uploads `apps/web/test-results` and
`apps/web/playwright-report` after each non-cancelled run. On failures these
contain screenshots, videos, traces, the HTML report, and the production
server's structured `server-<port>.log` (one per app port); server logs run at `info` level so request
IDs can be correlated with browser failures without rerunning CI.
`scripts/e2e-artifact-sanitizer.ts` redacts tokens, cookies, placeholder
secrets and any PEM private key before upload. The e2e server keeps its TLS
edge key out of `test-results` altogether: it is created in a private
temporary directory and deleted once loaded.
