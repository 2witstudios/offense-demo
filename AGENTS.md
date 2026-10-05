# Offense Demo engineering map

This file is the short operating map for the repository. It states the rules
that apply everywhere and points to the deeper source of truth. Keep behavior
and detailed procedures in the linked documents, not here.

## Start here

- Runtime and package manager: Bun, pinned by `.bun-version` and
  `package.json`. Use Bun only: never npm, npx, yarn, or pnpm.
- Repository shape: Bun workspaces plus Turborepo; one modular monolith.
- Delivery: `apps/web` owns Next.js routes and feature-local application
  operations; `apps/realtime` is the WebSocket deployment (ADR 0031).
- Domain: `packages/domain` (`@offense-demo/domain`) is framework-free and pure
  (ADR 0005). The template ships a placeholder; replace it with your rules.
- Contracts: `packages/protocol` owns portable, versioned JSON contracts.
- Adapters: `packages/db` owns PostgreSQL; `packages/redis` owns expendable
  Redis state. Database rows are persistence representations, not domain
  entities.
- Project identity: `project.config.json` holds the repository slug, display
  name and PageSpace drive, page and channel ids. Scripts read ids from it;
  nothing hard-codes them.
- Package responsibilities and allowed edges: [architecture overview](docs/architecture/overview.md).
- Local setup and command catalog: [local development](docs/development/local-development.md).
- Test tiers and test rules: [testing](docs/development/testing.md).
- UI rules, including mutating forms that work without JavaScript: [UI conventions](docs/development/ui-conventions.md); brand locations: [branding](docs/development/branding.md).
- Policy decisions and the policy gate: [identifier strategy](docs/decisions/0018-cuid2-identifiers.md), [token and secret ownership](docs/decisions/0019-token-secret-ownership.md), [auth activation](docs/decisions/0020-auth-activation-gates.md), [AIDD overrides](docs/decisions/0021-repository-aidd-overrides.md), and [greenfield baseline](docs/decisions/0023-greenfield-baseline.md). All records: [decision index](docs/decisions/README.md).
- Structural change recipes: [extending the repository](docs/development/extending.md).
- Parallel sessions, branches, and vertical ownership: [parallel work](docs/development/parallel-work.md).
- Preferred multi-agent orchestration: [pu workflow](docs/development/pu-workflow.md).
- Merges and the two operating modes: see "Two modes" below and [pu workflow](docs/development/pu-workflow.md).
- New epics: the repository skill [epic-pipeline](.claude/skills/epic-pipeline/SKILL.md) (plan, automated plan review, owner approval, tasking, orchestration).

## Starting a new project

This repository is generated from the init-offense template. Creating a
project, bootstrapping its PageSpace drive and the manual steps that remain
(machine user, review-record GitHub App, Resend, Fly) are in the
[README](README.md#quickstart). Until `bun drive:bootstrap` has run, every
PageSpace-backed command refuses with a "not provisioned" error rather than
guessing an id.

## Dependency rules

- Dependencies point inward: delivery and feature operations may call domain,
  protocol, and adapters; domain and protocol never import React, Next,
  Drizzle, Bun SQL, Redis, HTTP, or framework session globals.
- Import workspace public APIs only. Declare every direct dependency in the
  owning package. The ESLint rules and `scripts/check-boundaries.ts` enforce
  declared dependencies, the allowed-edge table, the acyclic graph, and
  explicit exports.
- Put new work in its owning feature or package. Do not add broad `utils`,
  service, registry, or barrel files. Shared abstractions require two real
  consumers.
- A new package requires a responsibility, owner, explicit public exports,
  allowed dependencies, tests, and a package-map row. Add package-specific
  `AGENTS.md` only when its rules differ from this contract.
- Before adding or configuring a dependency, read its version-matched official
  documentation. Record significant direct dependencies in
  [the dependency registry](docs/dependencies.md); add an ADR for consequential
  choices. For Next.js, read the installed docs under
  `apps/web/node_modules/next/dist/docs/` first.
- No Rust, Kubernetes, Kafka, event sourcing, second Redis client, speculative
  shared package, or second validation/error/state-management library
  without an explicit architectural decision.
- No admin screens or admin-only routes in `apps/web`: admins get a
  separate future admin app with its own accounts and a signed internal
  API (`scripts/check-boundaries.ts` enforces this mechanically); see
  [ADR 0043](docs/decisions/0043-no-admin-surface-in-participant-app.md).

## Design constraints

- Security practices follow Eric Elliott's guidance: zero trust at every
  boundary, pure functions everywhere, unguessable cuid2 identifiers
  (`@paralleldrive/cuid2`) instead of UUIDs, SHA3-256 hashing for secret
  storage and comparison, and OS CSPRNG entropy (never `Math.random`)
  wherever randomness touches anything security-adjacent.
- Prefer pure functions. Domain, protocol, and feature logic have no ambient
  clock, environment, randomness, or I/O. Inject time, IDs, and resources at
  the edges; rejected operations leave state unchanged.
- Validate untrusted input, environment, and serialized messages at trust
  boundaries. Pass explicit principals into operations. Every access
  decision goes through the one pure authorization core (ADR 0048):
  `authorize` in `@offense-demo/auth`, reached by a route through
  `authorizeRequest` and by a page through `readRoute`. Adding a
  capability: [extending](docs/development/extending.md#adding-a-capability).
- Greenfield over backward compatibility: until first ship there are no
  deployed consumers, so no compat surface may outlive the mistake that
  required it. When a foundational choice proves wrong before first ship,
  remove it outright — rewrite the baseline, delete the compatibility code,
  tests, and policy exceptions, and supersede the documenting ADR. Never
  accrete legacy modes, dual-shape validators, or migration replay fixtures
  for behavior nobody depends on (ADR 0023).
- Transitions are total. Once we decide to replace an approach (a pipeline,
  integration, transport, or tool), replace it in one move: delete the old
  code path and its tests, config, CI steps, secrets, docs, and everything it
  created outside the repo (PageSpace workflows, webhooks, triggers, data
  rows). Never keep a fallback, dual path, compat special case, or "kept for
  now" remnant of an approach abandoned because it did not work, and never
  write docs that narrate the old way. If a removal must wait on a deploy,
  track it as a task, not a comment.
- PostgreSQL is the durable source of truth. Redis is expendable and must use
  validated namespaced keys with expiry. See
  [persistence](docs/architecture/persistence.md) and
  [database operations](docs/operations/database.md).
- Use UTC ISO timestamps, cuid2 application IDs, documented UUID exceptions, and integer millisecond durations. cuid2 IDs are identifiers, never bearer secrets. Use
  structured logging; never log credentials, cookies, raw request bodies, or
  raw exceptions. The one exception is the local-development terminal mailer,
  which prints emailed sign-in links to stderr and never to the structured
  logger ([ADR 0050](docs/decisions/0050-local-development-terminal-mailer.md)).
  Public errors must not expose internals.
- Every log field, database column, Redis key and vendor-held record has a
  privacy category (`none | identifier | personal | sensitive | secret`)
  and, when personal, a visibility (`public | private`); identifiers are
  scoped per telemetry surface (logs, errors, analytics), never global. See
  [privacy](docs/operations/privacy.md), [ADR 0036](docs/decisions/0036-privacy-by-design.md).
- A personal-data column ships with its classification (category,
  visibility, purpose, lawful basis, retention, erasure) in the PR body in
  the same change. See [privacy](docs/operations/privacy.md).
- Error tracking and product analytics go only through the `ErrorReporter`
  and `track` adapters (Sentry, PostHog); both stay inert without their
  deploy-time keys, and a raw exception goes only to the scrubbed error
  tracker, never to logs. See [ADR 0037](docs/decisions/0037-error-tracking-and-product-analytics.md).
- `necessary`, `analytics` and `replay` consent categories always exist in
  the stored schema regardless of deploy configuration; `unanswered` counts
  as denied. See [privacy](docs/operations/privacy.md).
- Schema changes use `bun db:generate`, reviewed SQL and metadata, forward
  migrations, and expand/contract for rolling deployments. Never rewrite an
  applied migration or reset production; the only sanctioned history rewrite
  is a greenfield baseline squash recorded in
  `policy/migration-baselines.json` (ADR 0023, ADR 0038), which requires resetting
  every local and test database once.

## Test contract

- Use TDD: red, green, refactor. New behavior lands with tests in the same
  change; never skip, weaken, or disable tests.
- Tests use RITEway's `riteway/bun` imports and call `setupRitewayBun()` once
  per file. Prefer `assert({ given, should, actual, expected })`; assert an
  expected `AppError` with `assertRejects` from `@offense-demo/errors/testing` (it
  checks the code), and use a specific `toThrow(message)` only for other
  exception paths, never a bare `.toThrow()`. The canonical example is
  `packages/domain/src/project.test.ts`.
- Inject clocks and IDs. Do not sleep-and-hope, share mutable test state, or
  point integration tests at non-test data. `TEST_DATABASE_URL` must end in
  `_test`; integration also requires `TEST_REDIS_URL`.
- `bun run knip` is a required dead-code gate for unused files, exports, and
  dependencies. Keep `knip.jsonc` ignores limited to genuine implicit uses.
- `bun run duplication` is a required copy-paste gate (jscpd, ADR 0026): any
  clone of 50+ tokens that is not in `.jscpd-baseline.json` fails, and tests
  are scanned the same way against `.jscpd-tests-baseline.json`. When it
  fires, consolidate — extract the shared function, component, or data table
  into the owning module — rather than raising `minTokens`, adding an ignore,
  or re-baselining. When consolidation would break a dependency rule, follow
  ADR 0026's exception procedure (a dated row); the baseline otherwise only
  shrinks.
- `bun evidence` fails on suites no runner claims, integration guards that
  skip instead of throwing on missing services, and gates that silently
  stop running in CI. `bun run duplication`, `bun invariants`, and
  `bun evidence` are part of `bun check`.
- Repository overrides are explicit: Bun/RITEway replace generic Vitest guidance,
  `@offense-demo/errors` plus native `Error.cause` replaces `error-causes`, durable
  behavior uses real integration tests, and unit IDs are deterministic while
  integration isolation may use CSPRNG IDs. `bun policy` enforces the
  ADR-linked, time-bounded exception registry.
- This file is the only agent-facing operating map. Never fork it into a
  second top-level agent document (CLAUDE.md and friends); docs drift
  becomes contradictory instructions.

## Verification commands

Run commands from the repository root. Environment-dependent commands use the
values in `.env`; initialize with `bun install --frozen-lockfile` and
`cp .env.example .env` when needed.

- `bun doctor`: checks Bun version, environment parsing, PostgreSQL reachability,
  migration currency, Redis reachability, agent identity, and architecture
  boundaries. Add `--json` for a machine-readable report. It should pass
  before service-based work.
- `bun check`: the pre-push gate: `format:check`, lint and boundaries, policy,
  Knip, duplication, invariants, evidence, typecheck, unit tests, metrics policy, and
  production build. It does not boot Next or require integration services,
  but its policy stage lists open PRs for ADR and migration number claims,
  so it needs the network and an authenticated `gh` (`GH_TOKEN` in CI).
- `bun check:affected`: fast per-vertical inner loop over changed files and
  the affected turbo graph. A convenience, never a substitute for `bun check`.
  The committed `.githooks/pre-push` hook runs it on every push once a clone
  opts in with `bun hooks:install`; CI enforces the full gate.
- `bun migrations:check`: fails a branch that rewrites, reorders, truncates,
  or chain-breaks shared migrations relative to `origin/main`. Required
  before pushing `packages/db/migrations/` changes; migration generation is
  single-writer at a time.
- `bun verify`: runs `check`, integration tests, browser E2E, and applies
  migrations twice to `TEST_DATABASE_URL` to prove idempotency. It requires
  isolated services and a test database. Add `--json` for a report.
- `bun scenario <name>`: runs `scenarios/<name>.ts` as a deterministic domain
  lifecycle scenario; unsupported scenarios report a documented boundary.
  Scenario rejection steps also prove atomic state preservation.
- `bun invariants`: validates `spec/invariants.json` against the domain's
  invariant registry, referenced test source names, and registered negative
  fixtures. Add `--json` for a report.
- `bun test`: fast deterministic tests. `bun test:integration` requires
  `bun slot:up` (shared services, this checkout's migrated databases). `bun test:e2e` runs Playwright
  against the production build and uses Node 24 only as its driver runtime.

## Local workflow

1. `bun install --frozen-lockfile`
2. `cp .env.example .env`
3. `bun slot:up`
4. `bun dev` or the clean-environment `bun dev:agent`
5. `bun doctor`, then the relevant tests and verification gates

Every checkout (the main checkout and each git worktree or `pu` slot) shares
one local Postgres and Redis and owns the databases, Redis namespaces and
ports `bun slot:up` derives from its folder; never hand-edit them. Run
`bun slot:down` at handoff when no reviewer needs the data. See
[local development](docs/development/local-development.md#parallel-sessions-on-one-machine)
and [ADR 0034](docs/decisions/0034-shared-stack-slots.md).

Use `bun db:generate` for schema changes, review generated SQL, and use
`bun db:studio` only for local inspection. See [database operations](docs/operations/database.md)
for test roles, reset restrictions, and migration safety.

## Two modes: owner and autonomous

The owner works in the loop and merges any PR whenever they choose; the
independent review record may follow the merge. Agents started by `pu` run
autonomously (`AGENT_AUTONOMOUS=1`) under the agent machine identity from
the main checkout's `.env.agent`, never the owner's token or SSH key
(`bun doctor` checks it). Until the owner creates that file, agents act as
the owner and `bun doctor` warns. An autonomous agent never merges. It
requests a merge with `gh pr merge --auto --merge` only after confirming
the live `main` ruleset requires `review-record`; GitHub then merges only
once every required check passes, including `review-record`, which only an
independent review record for the exact head SHA can mint. Without that
ruleset it reports "ready for owner merge" to its parent and waits.

- Spawn agents with `pu spawn` and message them with `pu send`. Builders
  report to whoever spawned them directly; the owner is not the message bus.
- Code-writing help is a `pu` child in its own worktree, never a
  worktree-isolated subagent or fork; subagents and forks do read-only work.
- Take ADR numbers from `bun adr:next`; `bun policy` fails a
  number an earlier open PR holds.
- A decision made on the owner's behalf is recorded with
  `bun decision:record`; it stays open until confirmed or overruled.
- Plans get an independent automated review with `bun plan:review` before
  the owner approves them.
- Board plumbing is committed: `bun board:read|status|create|relate|replace`
  and `bun board:stale`. Hand off with the `/handoff` skill.

## Work management

All repository work is planned in the PageSpace drive declared below (via
the `pagespace` CLI); its `Roadmap` page is the operating system. The drive
and its pages are recorded in `project.config.json`; `bun drive:bootstrap`
provisions them and rewrites the block between the markers below, which
the `/task`, `/review` and `/pr` skills read to find the drive and its
conventions page.

<!-- drive:start -->

Drive: "Offense Demo" (`ygwvxpnpuiwyqq2u8bypnni7`) · conventions page "Task artifacts and linking" (`hfnrv8xfzpgmi1tc7urvn36e`)
<!-- drive:end -->

Work only on committed tasks: claim `Ready` leaves, advance In Progress to
In Review at handoff, and mark Done only when acceptance criteria are
proven. Status belongs in the status field; task bodies are acceptance
criteria (`Given X, should Y`). Plan and task epics with the `/task` skill
(or the repository [epic-pipeline](.claude/skills/epic-pipeline/SKILL.md)
skill for the full plan → review → approval → orchestration loop).

PageSpace is the workspace, not only the board. Plans, prompts, handoffs and
review records are task artifacts: they live in the drive's `Plans`,
`Prompts` and `Reviews` folders (one subfolder per epic), reusable prompts
and skills live in `Library`, and tasks link them with page mentions. The
rules are the drive's conventions page ("Task artifacts and linking", named
in the drive block above); read it before producing any of these.
Board and scratch-versus-durable-artifact rules (what counts as scratch, who
keeps the board current, the no-edit-criteria rule, and Done coming only
from an independent review record) are in [parallel
work](docs/development/parallel-work.md#branch-and-worktree-hygiene); they
apply to every agent, worktree or not.

Work that is not an epic leaf goes in the drive-root `Issues` task list,
filed into one of its buckets (Bugs, Test coverage, Agent tooling, Doc and
spec drift, User feedback), never in GitHub Issues: defects found after the
owning leaf is Done, review findings and minors with no open leaf to carry
them, and small non-epic improvements. The test is whether an open leaf
owns it: if one does, the finding is a follow-up leaf under that phase
regardless of merge state. Title `ISSUE-n — Given X, should Y`; the body
records origin (PR, review record, reporter), why, and the acceptance
criteria; the Related pages block links the origin. An issue closes through
a PR that names it, or is promoted to an epic leaf when it grows into
feature work. `Issues/Backlog` holds feature candidates awaiting a spec,
and `Issues/Pending decisions` the open owner decisions. Filing is an
obligation: whoever observes a defect or a deferrable improvement —
reviewer, builder, or orchestrator — creates the leaf or issue in the same
session rather than mentioning it in prose, because an observation that
lives only in a record or a handoff is lost once the PR merges. Before a
stage starts, the orchestrator reads every `Issues` bucket for anything
touching the files or phase about to be built and carries it into the
prompt; an epic cannot close while any issue it produced is untriaged
(promoted, scheduled, or deferred by the owner with a reason).

Open and update pull requests with the `/pr` skill: the description links
the task, plan and prompt pages (and handoff and reviews as they land) so a
reviewer can check the change against what was asked, and every review
verdict (`/review`) is also posted as a PR comment. PR titles are
conventional commits: the documentation pipeline classifies a merge from
that prefix (`!` marks a breaking change) and reads task codes from the
title, branch and body, so name every task code in full (`AUTH-3.1`,
`AUTH-3.2`, never `AUTH-3.1–3.6`). The body carries `Builder: <agent id>`,
which the review-record check compares with the record's reviewer. A merged
task moves to **Merged** automatically and reaches Done only from an
independent review record. Use `/triage` for review-comment triage.

Parallel sessions follow [parallel work](docs/development/parallel-work.md):
short-lived vertical branches, one open vertical per agent, and a deviation
from the plan means updating the plan before declaring done. The
orchestrator owns Agent Memory writes.
Reviews use the [review record](docs/development/review-record.md) format.

While work is open, post the daily Yesterday / Today / Blockers standup and
send scope, ceremony, epic, or incident updates to the drive's channels:
standup for daily standups, epic-updates for epic milestones, sprint-room
for merge notices and discussion, incidents for failures. Keep durable
environment findings in the drive's Agent Memory page. Deploy-rail and
production-data changes require a human-only sign-off leaf; agents never
self-approve.

## Deeper decisions

- Architecture: `docs/architecture/`
- Development: `docs/development/`
- Operations: `docs/operations/`
- Decision records: `docs/decisions/` ([index](docs/decisions/README.md))
- Dependency rationale and versions: `docs/dependencies.md`

Update the relevant deeper document when behavior or architecture changes.
Keep commits scoped and never commit `.env`, `.env.agent`, secrets, generated
build output, or `.pu/` runtime state (only `.pu/config.yaml` and
`.pu/agent-context.md` are committed).
