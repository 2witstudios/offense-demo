# Bun-Only Toolchain

{{displayName}} is a Bun repository. Bun is the only package manager, runtime,
script runner and unit/integration test runner. Node exists solely as the
upstream-supported Playwright driver runtime.

- Packages: never `npm`, `npx`, `yarn` or `pnpm` — only `bun`, `bun add`,
  `bun run` and `bunx`.
- Installed tool CLIs run under Bun: `bunx --bun knip`, `bunx --bun tsc`.
- Versions are exact, pinned via `.bun-version`, `engines` and
  `packageManager`; commit `bun.lock`; install with
  `bun install --frozen-lockfile`.
- Before adding or configuring a dependency, read its current official
  documentation; never rely on remembered APIs. Record consequential
  choices in `docs/dependencies.md` and an ADR.

Local binding: `AGENTS.md` in the `{{repo}}` repository.
