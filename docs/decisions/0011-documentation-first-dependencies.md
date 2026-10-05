# ADR 0011: Documentation-first dependency management

Status: accepted.

No dependency is installed from model memory or stale tutorials. Before
adding or configuring a dependency: read its current official documentation,
verify installation instructions and compatibility with pinned toolchain
versions, prefer stable releases, and record the choice in
`docs/dependencies.md` plus an ADR when consequential. Next.js is read from
the version-matched docs shipped inside the installed package.

Why: this repository is developed by humans and autonomous agents whose
training data lags the ecosystem. Recent concrete examples already validated
the rule: Next 16 replaced `middleware.ts` with `proxy.ts` and typed
`NODE_ENV` read-only; Drizzle's site advertised an RC while stable 0.45.2 was
correct; TypeScript 7 is outside typescript-eslint's support range.

Tradeoffs: slower adoption (a feature waits on a documentation read), and
registry maintenance duty. In exchange, upgrades are boring, agents do not
invent APIs, and removal paths stay open because every entry records why the
dependency exists and where its authoritative documentation lives.
