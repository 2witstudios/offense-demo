# Knip Dead-Code Gate

Unused files, exports and dependencies are defect inventory. Knip keeps the
inventory at zero.

- `bun run knip` fails non-zero on any unused file, export or dependency.
  It runs inside `bun check` and the CI `checks` matrix, so drift cannot
  merge.
- Findings are fixed by deleting dead code or declaring real usage — never
  by renaming exports or weakening the config to hide findings.
- Config lives in `knip.jsonc`. Ignores are limited to genuine implicit
  references (for example `transpilePackages` string references), with the
  reason documented where the ignore is declared.
- Dependencies are declared by the workspace that imports them: a package's
  `package.json` lists exactly what its source and tests use; shared
  tooling stays at the root.

If a finding looks wrong, fix the discovery (entry points, plugin config),
not the report.
