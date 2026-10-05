Installed copies: ~/.claude/skills/task, ~/.codex/skills/task, ~/.config/opencode/skills/task. Upstream: pointguard skills/task/SKILL.md. This page is the drive's reference copy; edit upstream, then sync.

---

name: task
description: >
Plan and task an epic on the repo's PageSpace board as a dependency-ordered timeline (no dates):
plan draft with a leaf manifest, independent plan review, one owner approval, then Epic → Phase →
leaf tasks whose Prerequisite lines, board order and Ready set are derived from the manifest.
Use when the user asks to plan an epic, break an epic or feature into board tasks, sequence or
re-sequence work, sync epic progress, replan an epic, check the board against the plan, or says
"/task", "/task sync", "/task replan", "/task validate".
compatibility: Requires the pagespace CLI with an active key and gh for PR prerequisites. In a repository with bun board:*, bun decision:record, bun plan:review or bun adr:next ({{displayName}}) it uses them.
---

# 🗺️ task

Act as the orchestrator turning intent into committed, ordered work. The board is the operating
system: a leaf exists only when it is provable, owned and placed on the timeline. The timeline is
dependency order, never dates: the plan's Manifest says what waits on what, and everything else
(timeline stages, critical path, Prerequisite lines, board order, which leaves are Ready) is derived
from it.

Constraints {
AGENTS.md governs. Read it first for the drive id, the Tasks page, the artifact conventions page and the task-code prefixes in use. No drive declared => say so and stop; never fall back to local files.
PageSpace is the record. Never keep a plan, manifest or task list only in local files, /tmp, plan mode or an agent todo list.
The Manifest is the single source of truth for order. Never hand-edit the Timeline section, a Prerequisite line or board order without changing the Manifest first and regenerating.
Never task, prompt or spawn before the owner approves the reviewed plan.
Stop only at owner approval and at human-only leaves (deploy rail, production data, identities, secrets, brand sign-off). Everything else runs on.
A decision you make on the owner's behalf is recorded as an open decision (`bun decision:record` when present, otherwise the plan's Pending decisions list). Never bury one as "please confirm".
No due dates or start dates on tasks. Dates appear only in Revision entries, the approval line and the delivery log.
Never edit the criteria of a leaf already delegated; scope changes go back to whoever delegated it.
Promote, never demote: this skill moves `pending` leaves to `ready` and nothing else. Status past Ready belongs to builders, reviewers and the orchestrator.
Never invent a page id; verify with `pagespace pages read-details <id>`.
Never put secrets, tokens or .env material in a page or message.
}

## Shapes

Board {
Tasks (TASK_LIST)
Epic — <Name> closing criteria; Related: Plan, Conventions, Delivery log
Phase — <Name> organizational grouping; never forces independent work to wait
<CODE>-<P>.<N> — Given X, should Y one leaf = one PR
<CODE>-<P>.<N> (human-only) — Given X, should Y
}

Leaf {
One PR, 1–3 files, one provable output. Criteria are "Given X, should Y", each mapping to one assertion.
Too large (more than ~3 files, crosses a module boundary, has parallel parts) => split it.
Too small (under ~20 lines of real logic, no independent proof) => merge it into a neighbour.
Containers (epic, phase) are never worked directly and complete only when every child is Done.
  <P> is the phase number from the plan's Phases list; <N> numbers leaves within it.
  Follow-ups discovered later take a suffix (`AUTH-7.5a`) or the next number; never renumber existing leaves.
}

Plan (see references/plan-template.md) {
Planning line: `Planning: <n> — <draft|reviewed|approved|tasked|validated|handed off>`, the last process step completed. Resume at n + 1.
Phases: `<P> — <Name> — <closing criterion>`, one line per phase.
Manifest, one row per leaf: | Leaf | Title | Owner | Depends on | Single-writer | Page ID |
Title: the short `Given X, should Y` headline (no `(human-only)`; that comes from Owner).
Owner: Builder, Reviewer, or `<name> — human` (=> human-only leaf).
Depends on: leaf codes and external prerequisites (`ADR <n>`, `PR #<n>`, `contract <name>`). `—` => none.
Single-writer: the serialized resource the leaf writes (migrations, app router, theme tokens, config gate, ADR numbering), or `—`.
Page ID: the leaf's task page id, filled in at tasking. The taskId for `tasks update`/`reorder` is resolved from `tasks list --json` by pageId.
Leaf criteria: one sub-list per leaf code with its full Given/should bullets. The owner approves these; tasking copies them verbatim.
Timeline: derived, in the exact line grammar below.
}

External prerequisite met {
PR #n => `gh pr view <n> --json state` is MERGED.
ADR n => the ADR file's status is Accepted on the default branch.
contract <name> => present on the default branch.
Cannot verify => not met; list it under Blocked.
}

deriveTimeline(manifest) {

1. Declared graph: an edge d → leaf for every leaf code d in Depends on. Reject unknown codes and cycles.
2. Order: topological order of the declared graph, ties broken by manifest order.
3. Single-writer edges: within each Single-writer group, chain its leaves in that order (each depends on the previous one in its group). Order is a linear extension, so this never adds a cycle.
4. Derived graph = declared edges + single-writer edges. Every derived edge becomes a Prerequisite line on the board.
5. Stage of a leaf = 1 + the maximum stage of its derived-graph dependencies; 1 when it has none. External prerequisites never add a stage; they are listed as the stage's gate.
6. Per stage: lanes = min(leaf count, builder cap); builder cap comes from the Timeline header, default 3. A stage whose leaves share one single-writer resource has 1 lane.
7. Gate of a stage: every human-only leaf and external prerequisite that its leaves depend on directly, or `none`.
8. Critical path: the longest chain in the derived graph by leaf count; ties go to the chain whose leaves come first in manifest order.
9. Walking skeleton (if the plan names one): its leaves must land in the earliest stages. If they don't, add dependencies in the Manifest.
   Emit, one line per stage, leaves in manifest order: - **Stage <s> — <sequential | parallel (<k> lanes)>[, single writer (<resource>)]; gate: <codes and externals | none>**: <code> · <code>
   then `Critical path: <code> → … (<n> leaves)`, `Human gates: <codes | none>`, `Walking skeleton: <codes | none>`.
   }

promote() {
For each `pending` leaf, not human-only, whose derived-graph dependencies are all Done and whose external prerequisites are all met: set it to `ready`.
Unblocked human-only leaves are named for the owner, never set Ready or delegated.
Never demote a leaf, and never touch a leaf past Ready.
}

## Process

### 0 — Ground

ground() {

1. Read AGENTS.md and the drive's artifact conventions page. Note the drive id, Tasks page id, Plans/Prompts/Reviews folder ids, Epic Updates and Incidents channel ids, human user ids for owners, and repo helpers (`bun board:*`, `bun decision:record`, `bun plan:review`, `bun adr:next`).
2. `pagespace search text "Plan — <Name>" --drive <id>` and `search text "Epic — <Name>"`: resume an existing epic at its Planning line + 1; never duplicate it.
3. Code prefix: reuse the epic's existing one; otherwise propose a 2–6 letter prefix not already on the board and confirm it in the approval message.
4. Read the Issues list (when present) for items this epic should absorb.
   }

### 1 — Plan draft

draftPlan() {

1. Create `Plans/<Epic>` if missing, then `Plan — <Epic>` (DOCUMENT) from references/plan-template.md.
2. Read every accepted ADR and doc the plan touches. Take ADR and migration numbers from `bun adr:next` when it exists, never from memory.
3. Write Why, Owner decisions, Design, Out of scope, Constraints.
4. Write Phases, the Manifest and Leaf criteria. Apply the Leaf sizing rules. Declare every prerequisite; mark single-writer resources.
5. Run deriveTimeline and write the Timeline section.
6. Set `Planning: 1 — draft`.
   }

### 2 — Plan review

reviewPlan() {

1. Run an independent read-only reviewer: `bun plan:review <planPageId>` when present; otherwise a fresh subagent given only AGENTS.md, the ADR index, this skill's Plan and deriveTimeline sections and the plan page. It checks scope, leaf sizing, testable criteria, missing prerequisites, cycles, single-writer conflicts, and that the Timeline is exactly what deriveTimeline produces. Verdict: APPROVE | CHANGES REQUESTED.
2. Publish it as `Plan review — <Epic> (<reviewer>)` in `Reviews/<Epic>`, mentioning the plan.
3. CHANGES REQUESTED => revise (Manifest first, then regenerate the Timeline), add a dated Revision entry, review again. Take a disagreement to the owner only when it is theirs to decide (scope or intent), never because of a round count.
4. Set `Planning: 2 — reviewed`.
   }

### 3 — Owner approval (the one stop)

approve() {

1. One message to Epic Updates (`pagespace channels send <id> "<msg>"`) and to the user: plan link, review verdict, Timeline summary (stage count, critical path, human gates), code prefix, and every open decision.
2. Wait. Owner changes to scope or dependencies => Revision entry and back to reviewPlan. Wording-only changes => Revision entry.
3. Record `Approved by <owner>, <YYYY-MM-DD>.` on the plan. Set `Planning: 3 — approved`.
   }

### 4 — Tasking

task() {
Follow references/board-commands.md. Use `bun board:*` when the repo has them; otherwise the pagespace recipes. Idempotent: rerunning it after a replan creates only what is missing.
Pass 1 — create:

1. Create `Delivery log — <Epic>` in Plans/<Epic> if missing.
2. Reuse or create `Epic — <Name>` under Tasks, each `Phase — <Name>` under the epic, and each leaf whose Manifest row has no Page ID under its phase. Titles: `<CODE>-<P>.<N> — <Title>`, with `(human-only)` after the code when Owner is a human (keep titles under ~100 chars). Priority: high for critical-path leaves, otherwise medium. Human-only leaves are assigned to the named human when their user id is known.
3. Write every new Page ID into the Manifest.
   Guard: if a dependency change would leave a leaf at Ready or later depending on an unfinished prerequisite, stop and report it; only apply after the orchestration owner has paused that leaf. Never demote it yourself.
   Pass 2 — bodies and order (all page ids now exist):
4. Leaf bodies: the Leaf criteria verbatim, then Related pages: Plan, Conventions, one `Prerequisite:` line per declared dependency (leaf mention or external reference), one `Prerequisite (single-writer <resource>):` line per single-writer edge. For existing leaves, rewrite only the Related prerequisite lines; never their criteria.
5. Epic and phase bodies: closing criteria from the Phases list ("Given every child Done and <criterion>, should close") and Related pages (Plan, Conventions, and Delivery log on the epic). Complete the plan's own Related line.
6. Order: phases by P under the epic; leaves within a phase by (stage, manifest order).
7. Removed leaves (dropped by replan): prefix the title with `Superseded by <code> —` or `Dropped —`, move them to Backlog when the drive has one, and never delete a page that has a PR or review.
8. Set `Planning: 4 — tasked` unless it is already higher.
   }

### 5 — Validate

validate() {
Read the board back (`pagespace tasks list <pageId> --json`, recursively) and the plan. Report each check PASS or FAIL:

- every Manifest row has exactly one leaf with that Page ID and code;
- each leaf's Prerequisite lines equal its derived-graph edges and external prerequisites;
- no cycles and no unknown codes; every dependency sits in an earlier stage;
- the Timeline section is exactly what deriveTimeline emits;
- human-only leaves carry the marker; when the Manifest owner's user id is known the assignee is that owner, otherwise no agent assignee;
- phase and leaf order match the Timeline.
  Leaves under the epic with no Manifest row (builder follow-ups) are Drift, not failures: list them and fold them in with replan.
  Any FAIL => fix the Manifest (then regenerate) or the board to match it, and validate again.
  All PASS => run promote(). First run only: set `Planning: 5 — validated`.
  }

### 6 — Hand to orchestration

handOff() {

1. Run sync once to write the first delivery-log entry.
2. Post the milestone (stage count, critical path, Ready leaves) to Epic Updates. Set `Planning: 6 — handed off`.
   Orchestration (prompts, spawning, reviews, merges) belongs to the drive's Library "Orchestrator stage loop" and pu:orchestrate, not this skill.
   }

### sync — keep the timeline honest

sync() {

1. Read the board statuses and the plan. Run validate's checks without fixing anything.
2. Confirm the plan carries `Approved by <owner>, <date>.` for its current revision. Without it, skip promote(): leave every pending leaf unchanged and say so in the log entry. Otherwise promote().
3. Prepend a dated entry to `Delivery log — <Epic>`: `<YYYY-MM-DD>: <done>/<total> leaves Done · timeline stage <s> of <S> (lowest stage with an unfinished leaf) · Ready: … · In progress: … · In review: … · Blocked: … (why) · Human gates open: … · Drift: …`.
4. A leaf listed as Blocked in an entry more than 24h old and still blocked => post to Incidents when the drive has that channel.
5. Every leaf Done and a closing review exists => tell the owner; never mark the epic Done yourself.
   }

### replan — change without drift

replan() { 0. A dependency change that leaves a Ready-or-later leaf depending on unfinished prerequisites is rejected unless the orchestration owner has paused that leaf first (back to pending); never leave a Ready leaf behind an unfinished prerequisite.

1. Edit the Manifest, Phases and Leaf criteria first (add, split, merge, re-depend, drop; new leaves take new codes or suffixes; fold in Drift leaves as rows with their existing Page IDs).
2. Regenerate the Timeline. Add `Revision <n> (<YYYY-MM-DD>): <what changed and why>`.
3. A change to a delegated leaf's criteria goes to whoever delegated it; do not edit it.
4. Scope or dependency changes to an approved plan => reviewPlan again; the owner approves scope changes.
5. Apply with task(), then validate().
   }

Commands {
🗺️ /task <name | source page> - run the stages from the one after the plan's Planning line
🔄 /task sync <epic> - promote unblocked leaves to Ready and prepend a delivery-log entry
✏️ /task replan <epic> - change the Manifest, regenerate the Timeline, update the board
✅ /task validate <epic> - check board, Manifest and Timeline agree; report PASS/FAIL and Drift
}
