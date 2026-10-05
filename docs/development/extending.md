# Extending the repository

Recipes for the most common structural changes. Structural changes need
a docs update in the same PR.

## Policy-first developer flow

1. Read ADRs 0018-0021 before adding identifiers, auth, secrets, or durable
   behavior.
2. Write the RITEway unit test first with injected deterministic IDs and clocks.
3. Add a real guarded integration test for durable PostgreSQL/Redis behavior;
   use a CSPRNG isolation ID only at that service boundary.
4. If compatibility requires UUID or direct randomness, add a narrow entry to
   `policy/exceptions.json` with path, rule, owner, reason, category, an
   existing ADR reference, and a future-or-today `reviewBy` date, then run
   `bun policy`.
5. Run `bun check`; do not implement the cuid2 schema migration or activate an
   auth route as part of policy-only work.

For parallel or isolated work, follow the preferred [`pu` workflow](pu-workflow.md).
Direct single-agent work may proceed without `pu`.

## Adding a package

1. Justify it: a package exists for a responsibility with an owner — never
   for symmetry with the prompt that created the repo. Shared code needs two
   real consumers first. This governs new packages and cross-feature
   modules, not a duplication-gate fix that stays inside the module that
   already owns both call sites; see [ADR 0026](../decisions/0026-duplication-gate.md#consequences)
   for that line.
2. Create `packages/<name>/` with `package.json` (exact versions, explicit
   `exports` mapping only public entry points), `tsconfig.json` extending
   `@offense-demo/typescript-config/base.json`, `src/index.ts`, and tests in
   `src/index.test.ts` (see [test file naming](testing.md#test-file-naming)).
3. Declare exactly the dependencies you import; allowed workspace edges are
   listed in `scripts/check-boundaries.ts` — extend the allowlist only when
   the edge is architecturally justified.
4. Add a row to the package map in `docs/architecture/overview.md`; add an
   `AGENTS.md` only if package rules differ from the root contract.
5. Verify: `bun lint` (boundaries), `bun typecheck`, `bun test`.

## Adding a route

1. Routes belong to a feature. If one exists (`apps/web/src/features/`),
   put application operations there; otherwise create the feature folder —
   not a global `lib/` or `components/`.
2. Page: colocate `page.tsx` under `src/app/<route>/`; export `metadata`;
   use the App Router boundaries (`error.tsx`, `not-found.tsx`) rather than
   bespoke error screens. A `loading.tsx` streams its page into a node only
   script reveals, so never put one above a page with a form
   (`docs/development/ui-conventions.md`).
3. API route: thin handler in `src/app/api/…` — resolve principal, call the
   feature operation through `handleOperation` (correlation, structured
   logging, error mapping), validate untrusted input with
   `parseValidated`/`readJson`, keep same-origin checks on mutations.
4. Route handlers must not contain domain rules; `@offense-demo/domain` owns invariants.
5. Extend `apps/web/e2e` if the route adds user-visible contracts.

## Adding a domain capability

1. Extend `@offense-demo/protocol` first if state crosses a boundary: schema,
   versioned snapshot/command/event shapes, tests.
2. Implement invariants in `packages/domain` as pure functions over
   portable values; no I/O, no ambient time, IDs and timestamps passed in;
   failing preconditions must leave state unchanged. Domain tests prove the
   invariant and the atomicity.
3. Register each invariant in `spec/invariants.json` with the test that
   proves it and a negative fixture (`bun invariants` checks the registry),
   and add or extend a deterministic lifecycle scenario under `scenarios/`
   (`bun scenario <name>`).
4. Durable effects go through an application operation:
   load authoritative record → domain operation → persist with optimistic
   version → map infrastructure failures to stable public errors.

## Replacing the placeholder domain

The template ships a tiny placeholder in `packages/domain` so every gate has
something real to run against. When a project starts:

1. Replace the placeholder operations and their tests in
   `packages/domain/src/` with the first real rule, test first, keeping
   `project.test.ts` (or a successor) as the canonical RITEway example the
   docs point to.
2. Replace the placeholder entries in `spec/invariants.json` and the
   scenarios under `scenarios/` in the same change, so `bun invariants` and
   `bun scenario` keep proving something real.
3. Add the product's tables in a forward migration (`bun db:generate`)
   following [persistence](../architecture/persistence.md), and map the
   generic realtime `room` topics onto the product's shared live unit.
4. Record consequential choices as ADRs (`bun adr:next` for the number).

## Adding a product vertical

A vertical is a self-contained feature slice several agents can build in
parallel. See `docs/development/parallel-work.md` for the coordination
rules.

1. Create the application operations in
   `apps/web/src/features/<vertical>/` (validation, principals,
   orchestration) — never a global `lib/`.
2. Create a route group `apps/web/src/app/(<vertical>)/` for pages and
   `src/app/api/<vertical>/` for handlers. Route groups isolate URL
   structure without touching other verticals' paths.
3. Shared app-router files (`src/app/layout.tsx`, `globals.css`) are
   coordination points: changing them belongs to a dedicated change that
   vertical PRs rebase onto, not to a vertical PR.
4. Add domain/protocol capability through the existing recipes first;
   a vertical composes the domain, it does not fork it.
5. Extend `apps/web/e2e` with the vertical's user-visible contracts.
6. Update the "Where work belongs" table in `README.md` and this file in
   the same PR.

## Styling UI

Write Tailwind utilities on the element (ADR 0028). There is no
`tailwind.config.*`: the theme lives in `apps/web/src/app/globals.css` and
`apps/web/src/app/theme/*.css`.

1. Use existing tokens (`bg-surface`, `text-ink-muted`, `p-4`, `rounded-lg`,
   `max-rail:…`). A value the theme lacks becomes a named token in the
   owning `theme/*.css` partial, never an arbitrary value.
2. Variant props become a pure `<name>-class.ts` function with a RITEway test
   asserting the literal classes; join fragments with `cn` from
   `apps/web/src/ui/cn.ts`. Variants own disjoint classes and never override
   the base.
3. Use `@utility` only for a pattern with no token-locked utility (named grid
   areas), never to hide a long class list.
4. Colors come from the `light-dark()` tokens; do not add `dark:` variants.
5. `bun check` fails on drift; run `bun format` to sort classes.

## Adding a protocol message

1. Add the message to the discriminated union (command or event) or snapshot
   schema in `packages/protocol` with the current `version` literal.
2. Follow the evolution rules in ADR 0009: additive within a version, new
   version literal for breaking change, never repurpose fields.
3. Add round-trip validation tests (parse → serialize → parse).
4. Announce in the PR description: protocol changes are cross-team contracts
   and need coordinated rollout with realtime/worker consumers.
