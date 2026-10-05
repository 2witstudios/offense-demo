# Codebase metrics

`bun run metrics` produces a JSON snapshot of source size, function complexity,
test size, Bun line/function coverage, 90-day git churn, and hotspots sorted by churn and complexity.
The output is deliberately repository-local so it can be reviewed without a
dashboard or hosted service.

## Commands

```sh
bun run metrics          # print the current snapshot
bun run metrics:check    # run coverage and enforce policy floors
bun run metrics:snapshot # append one snapshot to docs/metrics/history.jsonl
```

Snapshots are appended manually at release or milestone boundaries. Capture
them on an up-to-date `main` after the milestone's pull requests have merged,
then land the one-line append as its own small PR: the recorded `gitCommit` is
`HEAD` at capture time, so a snapshot taken on a feature branch names a commit
that excludes sibling work and may never reach `main`. The
history file is JSONL: one independently readable snapshot per line. It
contains the commit SHA when the repository has history; churn is `null` when
no file changed in the 90-day window.

## Signals

- **LoC:** non-blank TypeScript lines, split between source and test files.
- **Complexity:** AST-estimated cyclomatic complexity per function. The ESLint
  ratchet rejects application functions above 10 and files above 300 lines.
  Repository CLI tooling has a wider allowance because it coordinates file,
  process, and report parsing operations.
- **Coverage:** Bun lcov coverage for files owned by each workspace. Bun reports
  lines and functions, not branches; unimported files are not in its coverage
  denominator.
- **Churn:** distinct commits touching each file in the last 90 days.
- **Hotspots:** `LoC × churn × max function complexity`, similar to `aidd
churn`. The top ten files are included in each snapshot.

Coverage floors live in `docs/metrics/policy.json`. Raise a floor only when the
corresponding tests are part of the same change. Complexity and file-size
limits are enforced by `eslint.config.mjs` in the regular lint job.

`aidd churn` can be run separately with `bunx --bun aidd churn` once a longer
git history exists. The repository does not depend on it for CI metrics.
