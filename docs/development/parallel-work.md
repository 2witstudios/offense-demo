# Parallel work

How several agents (or humans) work on Offense Demo at the same time without
stepping on each other. The unit of parallelism is the **vertical**: a
feature slice that owns its routes (`apps/web/src/app/...`), its
application operations (`apps/web/src/features/<name>/`), and its tests.

## Session isolation (one machine)

All sessions share one local Postgres and Redis; each checkout owns the
databases, Redis namespaces and ports `bun slot:up` derives from its folder
([ADR 0034](../decisions/0034-shared-stack-slots.md), recipe in
[local development](local-development.md#parallel-sessions-on-one-machine)).
Summary: run `bun slot:up` in a new worktree, `bun doctor` catches a `.env`
naming another slot, `bun slot:down` at handoff, and a removed worktree's
data is pruned by the next `slot:up` anywhere. Unit tests need nothing.

## Branch and worktree hygiene

PageSpace's lesson: branch debris accumulates faster than agents clean it
(775 local branches, numeric leftovers, rescued worktree patches). Rules:

- Branches are short-lived and named for the vertical: `pu/<task-or-topic>`
  for work `pu` spawns (pu names every worktree branch `pu/<name>`), and
  `feat/<topic>`, `fix/<topic>`, `chore/<topic>` or `docs/<topic>` for
  direct work. No numeric or `backup/` branches; git history is the backup.
- GitHub deletes the branch when the PR merges (`delete_branch_on_merge`,
  applied by `bun github:rules`). Do not stack more than one open vertical
  per agent.
- Worktrees (`git worktree`, or `pu` slots) are the supported way to run
  multiple sessions on one machine; run `bun slot:up` in each so it gets
  its own databases and namespaces on the shared stack.
- The parent checkout stays on `main` and stays clear of committed work.
  Agents never run git in the parent checkout — no commits, checkouts,
  merges, or pulls there. All branch work happens inside the agent's own
  worktree, and new work reaches `main` only through a vertical branch
  and its PR. A worktree cannot commit to a branch another worktree has
  checked out, so a direct commit landing on `main` is always a
  parent-checkout violation, not a worktree accident.
- Every agent, worktree or not, keeps its tasks current on the board
  through the `pagespace` CLI: it claims leaves, advances statuses, creates
  follow-up tasks and records evidence. No agent edits the acceptance
  criteria or scope of a task delegated to it, and Done comes from an
  independent review record, never from the agent that did the work. Every
  agent also publishes its own handoff or review record in the drive's
  `Plans`/`Reviews` folders, because those are the record a reviewer reads.
  An agent's built-in todo lists, plan mode files, memory stores, local
  `plan.md`/`TODO.md` files and `/tmp` are scratch only, whichever agent it
  is (Claude Code, Codex, OpenCode): anything another session or a
  reviewer needs must be a PageSpace page.
- Deviating from a task's acceptance criteria is allowed exactly one way:
  take it back to whoever delegated the task, who updates the task body (or
  the plan) to describe the new approach **before** the work is declared
  done. Silent scope substitution is the failure mode this prevents.

## What each session must not own concurrently

- **Migrations.** One migration writer at a time across the whole
  repository; generation collides on the journal and applied migrations
  are immutable. `bun migrations:check` fails a PR that rewrites, edits,
  or reorders shared migrations; see
  [database operations](../operations/database.md).
- **Shared app-router files.** `src/app/layout.tsx`, `globals.css`, and
  `middleware`/`proxy` are coordination points: changing them belongs to
  a dedicated change, not a vertical PR. Vertical route groups
  (`src/app/(<vertical>)/`) keep the rest merge-free; see
  [extending](extending.md#adding-a-product-vertical).
- **Theme tokens.** `globals.css` and `src/app/theme/*.css` are the only
  Tailwind configuration. A vertical that needs a token adds it to the
  partial its area owns; a new color or scale step in `globals.css` is a
  dedicated change. Screenshot baselines in `apps/web/e2e/visual-baselines/`
  change only with an intended visual change (see
  [testing](testing.md#visual-parity)).
- **Shared config gates.** `eslint.config.mjs`,
  `packages/typescript-config/`, `.prettierrc.json` invalidate every
  turbo cache and affect all verticals; change them in isolated,
  dedicated PRs.
- **ADR numbers.** Two open PRs can claim the same next number with
  different filenames and merge without a git conflict. Take numbers from
  `bun adr:next`, which reads origin/main and every open PR; `bun policy`
  (in `bun check` and CI) fails a branch whose ADR number an earlier-opened
  PR already holds. The earlier-opened PR keeps the number. Migrations are
  named by generation timestamp (ADR 0038), and `bun migrations:check`
  fails one that does not append to main's.

## Inner loop

- `bun check:affected` — fast per-vertical loop (eslint/prettier on
  changed files, boundaries, duplication, affected turbo graph). It is a convenience,
  not a gate.
- `bun check` — the pre-push gate for every PR.
- `bun migrations:check` — before pushing any change that touches
  `packages/db/migrations/`.
- CI is per-PR isolated (service containers, concurrency cancellation);
  E2E runs once per PR in the dedicated browser workflow.

## Reviewing and merging parallel work

The owner merges any PR whenever they choose. Autonomous agents never merge:
once the live `main` ruleset requires `review-record`, they request it with
`gh pr merge --auto --merge`, and GitHub merges once the `CI gate`,
`Playwright E2E` and `review-record` checks pass; before that they report
"ready for owner merge". A merged task waits
in **Merged** until an independent review record grants Done; after the
enforcement cutoff a merge without one files review debt. `bun board:stale`
lists tasks whose status disagrees with git.

A leaf is reviewed as many passes as it takes to reach a verdict; a
disagreement goes to the orchestrator or owner only when it is a decision
only they can make, never because of a pass count.

Follow [review records](review-record.md): gates run up front, findings
with severity and fix commits, an explicit verdict, and a second pass
that re-verifies the first. Plan compliance (acceptance criteria versus
diff) is part of the verdict, not an afterthought.
