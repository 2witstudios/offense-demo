# 0039: Dated dependency audit exceptions; the audit is back in the CI gate

Status: accepted (owner decision of 2026-09-23).
Supersedes the fix-at-source-only rule recorded in ADR 0038's context
("the owner rejected `overrides`, `bun audit --ignore` and exception
registries") for the advisories named below.

Adapted for the template from the project it was extracted from.

## Context

`bun audit` joined CI as its own job. Drizzle 1.0 cleared the
esbuild advisory (ADR 0038), leaving one that no in-range upgrade fixes:

- **GHSA-82fw-gwwq-j7x9** (moderate) in `vitest` and `@vitest/mocker`
  3.2.7. `riteway` 9.3.0 hard-depends on `vitest ^3.2.4` for its
  `riteway/vitest` entry; the fix is vitest 4.1.11. `better-auth` lists
  vitest only as an optional peer.

The first decision was to fix both upstream and keep the audit job red
until then, so the job left the CI gate and the Incidents notification.
A permanently red check trains everyone to ignore it, and a new
advisory would land unnoticed beside the known ones.

## Decision

1. **Dated exceptions, nothing broader.** `policy/audit-exceptions.json`
   is the one list. Each entry names its GHSA id, the packages it affects,
   the dependency path, the reason, why Offense Demo cannot reach the vulnerable
   code, an owner, this ADR and a review-by date. `bun run audit`
   (`scripts/audit.ts`) runs `bun audit` with one `--ignore=<GHSA>` per entry;
   there is no `--audit-level` downgrade, no package-level or blanket
   ignore, and no `overrides` pin. Any other advisory still fails the job.
2. **Why the exception is unreachable.** vitest is a development dependency only:
   tests run on `bun:test` through `riteway/bun`, nothing imports
   `riteway/vitest`, `vitest` or `better-auth/test`, and no production image
   installs dev dependencies. Every future entry carries the same kind of
   reachability argument.
3. **Exceptions cannot rot.** `bun policy` fails an entry past its
   review-by date, an entry whose advisory `bun audit --json` no longer
   reports (remove it), and an entry whose advisory now reaches a package it
   does not list (the new path gets its own review). `bun audit --json`
   still lists ignored advisories, so the live check needs no second run.
4. **The audit rejoins the gate.** The `audit` job is back in `gate.needs`
   and `notify-drive.needs` in `.github/workflows/ci.yml`, so a new advisory
   blocks merges, holds staging back (staging deploys on a green `CI gate`)
   and posts to Incidents.
5. **Upstream fixes stay wanted.** When riteway drops or bumps vitest, the
   upgrade removes the entry;
   `bun policy` enforces the removal once the advisory is gone.

## Consequences

- The CI audit job is green on `main` and required again.
- A review-by date that passes turns `bun policy` red until the owner
  renews the entry with a fresh reachability check or the dependency is
  upgraded.
- `bun policy` now reads the npm advisory endpoint through
  `bun audit --json`; it already needed the network for `gh`.
