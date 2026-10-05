# Parallel worktree workflow

`pu` is the orchestration tool whenever more than one agent works, or when
work needs an isolated worktree. Direct single-agent work may proceed without
it.

## Two modes

- **Owner.** The owner's own sessions use the owner's GitHub identity and may
  merge any PR at any time.
- **Autonomous.** Every agent `pu` starts runs through
  `scripts/agent-launch.sh` (configured in the committed `.pu/config.yaml`).
  The launcher exports the machine identity from the main checkout's
  `.env.agent` and sets `AGENT_AUTONOMOUS=1`, so `gh` and `git push` act as
  the machine user over HTTPS, never with the owner's keyring token or SSH
  key. `bun doctor` fails if an autonomous session resolves to the owner.
  Until the owner creates `.env.agent`, the launcher starts agents
  as the owner with a warning and `bun doctor` warns.

## Spawning and messaging

```text
pu spawn -n <name> [-b main] [-a claude|codex|opencode] "<prompt>"
pu spawn --worktree <worktreeId> [-a claude|codex|opencode] "<prompt>"
pu send <agent> "<text>"
pu status | pu logs <agent> | pu attach <agent>
pu kill --agent <agent> && pu clean
```

A builder gets its own worktree. A reviewer joins the worktree it reviews
with `--worktree`. Run `bun install --frozen-lockfile` and `bun slot:up` in a
worktree when the work needs dependencies or services
([ADR 0034](../decisions/0034-shared-stack-slots.md)); agents decide that for
themselves. Agents report to whoever spawned them, so the owner never relays
status.

The spawning agent owns coordination, integration and cleanup; delegated
agents never modify another agent's worktree. Code-writing help is a `pu`
child in its own worktree. Worktree-isolated subagents and forks are for
read-only research and review.

## Pull requests and merges

- Open and update PRs with `/pr` (its body declares `Builder: <agent id>`)
  and hand off in one step with `/handoff`: push, PR, handoff page with the
  head SHA, tasks to In Review, parent notified.
- Independent reviews use the Reviewer contract and `/review`. The review
  record's `Candidate:` line mints the `review-record` check through the
  review-record GitHub App; nobody sets that status by hand.
- An autonomous agent never merges. It runs `gh pr merge <n> --auto --merge`
  only once the live `main` ruleset requires `review-record`; GitHub then
  merges once `CI gate`, `Playwright E2E` and `review-record` all pass.
  Without that ruleset it reports "ready for owner merge" to its parent and
  waits. The owner may merge directly at any time.
- After a merge, the tasks the PR names move to **Merged** and wait there
  for a review record to grant Done. After the enforcement cutoff, a merge
  without a `review-record` status files review debt (`ISSUE-n` plus a
  Sprint Room notice).

## Acceptance criteria

- Given parallel or isolated agent work, should use `pu spawn` and separate
  worktrees, with status and logs discoverable through `pu status` and
  `pu logs`.
- Given a focused delegated task, should use `pu send` or `pu attach` without
  editing another agent's worktree.
- Given completed or abandoned work, should use `pu kill` followed by
  `pu clean`; the orchestrator owns coordination and acceptance decisions on
  the PageSpace board while delegated agents keep their own status,
  evidence, follow-up leaves and Issues entries current.
- Given an autonomous agent, should request merges only with
  `gh pr merge --auto --merge`, and only once the live `main` ruleset
  requires `review-record`, while the owner may merge any PR at any time.
- Given direct single-agent work, should be allowed to proceed without `pu`.
