# 0026: Duplication gate

Status: accepted.

## Context

Copy-pasted blocks are the dominant decay mode of agent-written code: an agent
that cannot see (or may not touch) the original reproduces it. This repository
already did it once — `scripts/check-migration-journal.ts` re-implemented the
review-date rule private to `scripts/policy.ts` — and is about to build twelve
product routes that today are near-identical shells. Review catches this
late and inconsistently; a gate catches it on the push that introduces it.

## Decision

Adopt jscpd 5.3.0 as a repo-wide copy-paste tripwire. `bun run duplication`
(`bunx --bun jscpd`) runs in `bun check` and the CI `checks` matrix, and
`bun evidence` fails if either wiring disappears. It is also an always-on
gate in `bun check:affected` (the pre-push hook): a clone is only visible
against the whole tree, and the scan is cheap enough to run on every push.

- **Tool.** jscpd 5 is a prebuilt Rust binary shipped through per-platform
  `optionalDependencies` — the same delivery as Turborepo, with no install
  script and no native build step — behind a small launcher that runs under
  Bun 1.4.2. It is a root devDependency and repository tooling only. The
  "no Rust" foundation rule governs first-party code, not vendored tool
  binaries.
- **Scope** (`.jscpd.json`). First-party TypeScript, TSX, JavaScript, JSX and
  CSS under `apps/*/src`, `packages/*/src`, `packages/*/scripts`, `scripts`
  and `scenarios`. All of `apps/*/integration`, suites and helpers alike, is
  test code and belongs to the tests scan below. Root
  and package config files (`eslint.config.mjs`, `next.config.ts`,
  `playwright.config.ts`, `drizzle.config.ts`) are deliberately out of scope:
  they are declarative, one per tool, and have nothing to consolidate into.
  `scripts/duplication-config.test.ts` fails when any scan root stops matching
  tracked, scannable, non-ignored source, because `failOnEmpty` only fires
  when the whole scan is empty. Ignored:
  test suites and test support (`*.test.ts(x)`, `*.e2e.ts`, `*.test-support.ts`, `test-support/`), generated output
  (`.next`, `.turbo`, `node_modules`, migrations `meta/`), and the throwaway
  fixtures in `apps/web/src/ui/mock/`. jscpd's JSON config cannot carry
  comments, so this record is where each ignore is justified.
- **Sensitivity.** jscpd's defaults: exact clones of at least 50 tokens and 5
  lines. Higher `minTokens` values also drop every file smaller than the
  threshold from the scan (140 files analysed at 50, 118 at 70), which would
  blind the gate to exactly the small route and component files it exists to
  watch. Literal- and identifier-insensitive modes were measured and
  rejected: they flag data tables (icons, dashboard tiles, CSS tokens) rather
  than logic.
- **Ratchet.** Not a percentage. A percentage dilutes as the codebase grows
  (1.13% of 10k lines is 115 lines; of 50k it is 565). Instead
  `.jscpd-baseline.json` holds content fingerprints of the clones that
  existed on adoption, and `failOnNewClones: 0` fails the run on any clone
  absent from it. Fingerprints are content-based, so moving a grandfathered
  clone within its file does not trip the gate. `failOnEmpty` fails a run
  that matches no files, and a missing baseline file fails closed, so a
  broken config cannot pass silently.

The route shells under `apps/web/src/app/*/page.tsx` are **not** ignored and
are **not** in the baseline: they already delegate to one `RouteShell`
component and differ only in literals, so the detector reports nothing for
them. When real routes replace them they are scanned like any other source.

### Baseline on adoption (12 clones, 115 lines, 1.11% of 10,388 lines, 142 files)

Rows for clones whose files no longer exist in the template are dropped.

| Clone                                                              | Size                         | Follow-up                                                |
| ------------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------- |
| `scripts/check-affected.ts` ↔ `scripts/check-migration-journal.ts` | 17 lines, 104 tokens         | One shared `gitOutput` helper                            |
| `scripts/invariants.ts` ↔ `scripts/scenario.ts`                    | 6 lines, 60 tokens           | One shared `invariantId` reader                          |
| `scripts/policy-registry.ts` (two registry validators)             | 7 lines, 64 tokens           | Shared registry preamble                                 |
| `packages/config/src/index.ts` (two `superRefine` blocks)          | 10 lines, 58 tokens          | Shared production-HTTPS refinement                       |
| `packages/db/src/schema/{auth,users}.ts` (overlapping)             | 7–9 lines, 52–72 tokens each | Shared `createdAt`/`updatedAt`/`version` column fragment |

### Baselined after adoption

| Date       | Clone                                                     | Size                | Reason                                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | `apps/realtime/src/app.ts` ↔ `apps/web/src/server/app.ts` | 12 lines, 63 tokens | Each app's composition root builds its database and Redis from its own validated config. Apps cannot import each other, and a package depending on both `@offense-demo/db` and `@offense-demo/redis` only for this would be the speculative shared package AGENTS.md forbids. |

### Tests under their own gate (2026-09-23)

The owner decided that the copy-paste gate covers tests strictly: it fails
CI, with a baseline that only shrinks. Test code is scanned by a second
config, `.jscpd-tests.json`, against its own `.jscpd-tests-baseline.json`;
`bun run duplication` runs both scans, so `bun check`, CI and the pre-push
hook enforce both. Its scan roots name test files explicitly: unit suites
and `*.test-support.ts` under `apps/*/src`, `packages/*/src` and `scripts`,
`test-support/` folders, all of `apps/*/integration` and
`packages/*/integration`, `apps/web/e2e` (specs and support), and
`eslint.config.test.ts`. The same sensitivity, ratchet and exception rules
apply, and `scripts/duplication-config.test.ts` guards both configs' scan
roots. The source config's test ignores stay, so no file is counted twice.
This extends the gate's scope; it loosens nothing.

A one-off scan at `235b129` found 71 test clones, and 68 remained when the
gate was switched on. A cleanup consolidated them into shared fixtures (the
web integration `fixtures.ts` and flows, the auth unit
`auth-server.test-support.ts`, the redis `withRedis`, the protocol `parseOutcome`, the e2e sign-in
helpers) and left 11 in the baseline. A later change removed the nine retention-sweep clones, and moving
all of `apps/*/integration` into this scan dropped a stale pair, leaving
the rows below.

| Date       | Clone                                                                                                                              | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | `apps/web/integration/auth-email-change.integration.ts` ↔ `auth-session-management.integration.ts` (preamble)                      | Both suites import and call `requireTestServices` at load, which `bun evidence` requires, then build the same passkey flows; the shared part is that required preamble.                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-09-23 | `packages/redis/integration/presence-expiry.integration.ts` ↔ `presence.integration.ts` (preamble)                                 | Both suites import and call `requireTestServices` at load, which `bun evidence` requires, then import the same presence helpers; the expiry suite was split out for the file line limit.                                                                                                                                                                                                                                                                                                                                                       |
| 2026-09-28 | `apps/web/e2e/support/tls-edge.ts` ↔ `scripts/auth-alert-probe-unreachable-origin.test.ts` (self-signed cert generation, 28 lines) | Both build a loopback HTTPS server for a test, each generating its own self-signed cert via `openssl`. Consolidating into one shared helper was attempted (`scripts/self-signed-cert.ts`) but `check-boundaries.ts` refuses the cross-package relative import from `apps/web`'s `e2e/support/` into the top-level `scripts/` directory (`scripts/` is not yet its own workspace package with a declared, importable public API). Baselined until `scripts/` becomes a workspace package and the two can share a real workspace-package import. |

## Consequences

- The gate costs about 0.05 s locally (13 ms of detection), so it is free in
  `bun check` and CI.
- When it fires, the fix is consolidation: extract the shared function,
  component, or data table into the owning module (a shared abstraction now
  has its two real consumers). Deleting a grandfathered clone should be
  followed by `bunx --bun jscpd --update-baseline` (add
  `--config.jscpd-tests.json` for a test clone) so the baseline shrinks.
- Extracting a clone into a local helper or a `*.test-support.ts` file
  inside the module that already owns both call sites is this consolidation,
  not a new shared abstraction: it has no second package or feature as a
  consumer, so AGENTS.md's "shared abstractions require two real consumers"
  rule (which governs new packages and cross-feature modules; see
  `extending.md` and `overview.md`) does not apply and no exception record
  is needed.
- Supply chain, stated plainly. jscpd 5.3.0 was published on 2026-09-18, two
  days before adoption, and the 5.x line is a fresh Rust rewrite of a tool
  whose 4.x line was JavaScript. It ships prebuilt per-platform binaries
  through unscoped `optionalDependencies` (`jscpd-linux-x64-gnu` and
  siblings) and has a single npm maintainer. Mitigations present: npm
  provenance attestations on the release, no install scripts in the launcher
  package, an exact version pin, and `bun.lock` integrity hashes for every
  platform package. It is a devDependency that reads source and writes
  nothing, and it never ships. Rollback if the owner prefers the older line:
  pin the last 4.x JavaScript release (`4.3.0`) and re-verify the config keys
  and baseline support against it before relying on the ratchet.
- Known blind spot: jscpd does not match clones inside a file that fails to
  parse. `bun typecheck` and `bun lint` reject such files, so the gap cannot
  reach `main`.
- Exact matching will not catch a block copied and then renamed. That is
  accepted: the gate is a tripwire for the common case, not a proof of
  non-duplication.

## Handling a legitimate exception

Some duplication is correct — two modules that must not share a dependency,
or declarative documents that are clearer when self-contained. The order of
preference is:

1. Consolidate. This is the default and needs no record.
2. If consolidation is wrong, add the clone to the baseline
   (`bunx --bun jscpd --update-baseline`) **and** add a dated row to the
   table above naming the clone and the reason. A baseline diff without a
   matching row here is a review rejection.
3. Raising `minTokens`/`minLines`, adding an `ignore` glob, or removing a
   scan root weakens the gate for everyone; it requires a dated note in this
   ADR explaining why consolidation and a single baseline entry were both
   insufficient. Weakening the gate to hide a finding is the same violation
   as skipping a test.

References: [jscpd](https://jscpd.dev),
[repository](https://github.com/kucherenko/jscpd), [ADR 0013](0013-knip-dead-code-gate.md)
(the gate precedent).
