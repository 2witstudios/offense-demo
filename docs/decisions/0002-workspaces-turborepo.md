# ADR 0002: Bun workspaces with a Turborepo task graph

Status: accepted.

Package management and workspace resolution are Bun's job; task orchestration
(cache, parallelism, dependency-ordered builds) is Turborepo's. Turbo never
installs packages; Bun never caches task graphs. This split keeps each tool's
failure modes legible.

We considered a single-package repository (simplest, but boundaries would rely
on discipline) and independent repositories (strong boundaries, brutal
cross-cutting changes). Workspaces with mechanical boundary checks
(`scripts/check-boundaries.ts`, ESLint restrictions) give extraction seams
without repository sprawl.

Turbo runs in strict env mode: tasks receive only declared environment
variables (`turbo.json` `globalEnv`/`globalPassThroughEnv`). Local
env-dependent invocations use `bun --env-file=.env run turbo …` because Bun's
env file export is what populates turbo's environment. Task caching is
disabled for anything with external side effects (`test:integration`,
`test:e2e`, `dev`).
