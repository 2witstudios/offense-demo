# 0040: Actions pinned to commit SHAs; secrets scoped to their step

Status: accepted (owner agreed on SHA pinning in review).
Replaces the "major-version pins" guidance in CONTRIBUTING.md.

## Context

Workflows referenced actions by major tag (`actions/checkout@v7`). A tag is
a mutable pointer: the action's maintainer, or anyone who compromises them,
can move it to new code, and every workflow holding `FLY_API_TOKEN`,
`PAGESPACE_TOKEN` or a channel webhook secret then runs that code on its
next trigger (the tj-actions/changed-files compromise, 2025). GitHub's
hardening guidance is to pin to a full commit SHA, the only immutable
reference.

## Decision

1. **Every action is pinned to a full 40-character commit SHA, with its
   version as a trailing comment**:
   `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`.
   This applies to GitHub-authored actions too. Only local (`./`) and
   `docker://` references are exempt.
2. **Dependabot keeps the weekly update flow.** Its `github-actions`
   ecosystem updates a SHA pin and its version comment together, so bumps
   still arrive as reviewable PRs. Upgrades are reviewed, never auto-merged.
3. **Secrets are exposed only on the step that uses them.** No credential
   (`secrets.*` or `github.token`) sits in workflow- or job-level `env`, and
   no caller passes `secrets: inherit`. Checkout, setup and other
   third-party steps never see a token they do not need.
4. **`bun policy` enforces 1 and 3** through
   `scripts/workflow-hardening.ts`, over every file in `.github/workflows`.
5. **The repository Actions policy is an owner setting.** It allows only
   GitHub-authored actions, verified creators and an explicit list. Agents
   do not change repository settings.

## Consequences

- A pin shows its version only in the comment. The checker requires that
  comment because Dependabot reads it and reviewers need it.
- Adding an action means resolving its tag to a SHA
  (`gh api repos/<owner>/<repo>/commits/<tag> --jq.sha`) and writing both.
- A new workflow that puts a secret on its job fails `bun policy` before
  review.
