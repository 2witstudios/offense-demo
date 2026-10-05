# 0013: Knip dead-code gate

Status: accepted.

Unused files, exports and dependencies are defect inventory: they mislead
readers, inflate bundles and mask which declarations carry real contracts.
Adopt Knip 6.37.0 as a repo-wide gate. `bun run knip` runs at the root under
Bun (`bunx --bun knip`; Knip 6 officially supports Bun) and fails non-zero on
any finding, so drift is caught in `bun check` and the CI `checks` matrix
instead of in review.

Workspaces are discovered from the root `package.json` `workspaces` array;
Knip resolved every entry point, plugin (Next.js, Playwright, Drizzle,
ESLint) and `*.test.ts` file with no custom entry configuration. The only
config is `knip.jsonc`: one documented `ignoreDependencies` entry for
`@offense-demo/protocol` in `apps/web`, which is referenced by
`next.config.ts` `transpilePackages` as a string Knip cannot see. Ignores
must stay limited to genuine implicit references with the reason written
where the ignore is declared; weakening the gate to hide findings is the
same violation as skipping a test.

Findings are fixed by deleting dead code or declaring real usage — never by
renaming exports to satisfy the linter. Dependencies move into the owning
workspace's `package.json`: Knip flags imports that a workspace does not
declare, which is how `riteway` ends up declared per testing workspace while
tooling shared at the root stays at the root.

References: [Knip](https://knip.dev), [monorepo
configuration](https://knip.dev/features/monorepos-and-workspaces), [Knip in
CI](https://knip.dev/guides/using-knip-in-ci).
