# ADR 0001: Bun as the only runtime and package manager

Status: accepted.

Bun 1.4.2 is the runtime, package manager, script runner, and test runner.
One toolchain removes Node/bun dual-runtime drift, gives native TypeScript
execution, a fast test runner without a separate framework, and native
PostgreSQL/Redis clients (ADR 0012). The production deployment target is a
host or container that runs Bun.

Tradeoffs: Bun-native drivers do not run under Node; serverless/Node-only
hosting would require adapter replacement (deliberately isolated in
`@offense-demo/db` and `@offense-demo/redis`). The Playwright driver runs under Node 24
because that is its upstream-supported runtime; Bun remains the only package
manager and application runtime. Bun's version moves fast; we pin exactly
(`.bun-version`, `engines`, `packageManager`, CI) and upgrade deliberately.

Consequences: `bun.lock` is committed; npm/pnpm/yarn are never used; scripts
assume Bun's shell. Official references live in `docs/dependencies.md`.
