Installed copies: ~/.claude/skills/handoff, ~/.codex/skills/handoff, ~/.config/opencode/skills/handoff. Upstream: pointguard skills/handoff/SKILL.md. This page is the drive's reference copy; edit upstream, then sync.

---

name: handoff
description: >
Hand a finished branch to review in one step: push it, open or update the PR through /pr, publish
the handoff page with the exact head SHA, move the delivered tasks to In Review and notify the parent.
Use when a builder finishes, when the user says "/handoff", or at the end of a builder prompt.
compatibility: Requires git, the gh CLI, and the pagespace CLI with an active key. In a repository with bun board:* and bun agent:send ({{displayName}}) it uses them.
---

# 🤝 handoff

Act as a builder handing work to an independent reviewer. A handoff is one step, not five chores: every
part below happens in the same run, in this order, and the run is not done until each part is verified.

Constraints {
Never merge and never mark Done. Never edit the criteria of a task delegated to you.
Report gates honestly: exact SHA, commands run, NOT RUN with the reason. Never an inferred pass.
Scratch files carry the branch name (`<scratchpad>/handoff-<branch with / replaced by ->.md`), never a shared name.
Never put secrets, tokens, cookies or .env material in a page, PR or message.
}

Process {

1. Commit everything that belongs to the branch; `git status --short` shows nothing of yours. Record `HEAD` (the full 40-character SHA).
2. Push: `git push -u origin HEAD` (the pre-push guard and check run; never --no-verify).
3. PR: run /pr for the branch's tasks. Its body carries `Builder: <your PU_AGENT_ID>` and /pr verifies the published body.
4. Handoff page: create or update `Handoff — <what> (PR #<n>)` in the drive's handoff folder for the epic (Plans/<Epic> or the folder your prompt names), with: the head SHA; a criteria table (criterion → code path → test path → RED/GREEN evidence); gates with the SHA; negative controls; limitations and anything NOT RUN; how to reproduce every proof; page ids of every follow-up leaf or ISSUE-n you filed. It @-mentions the tasks and the prompt it ran from. Write it with `bun board:replace` (or pagespace pages replace-lines) from a branch-named scratch file.
5. Link: add the handoff and the PR to each task's Related pages (`bun board:relate <task> Handoff <handoffPageId>`), and put the handoff URL in the PR's PageSpace section (`/pr update`) plus one PR comment linking prompt, plan and handoff.
6. Status: move each delivered task to In Review (`bun board:status <taskPageId> in_review`).
7. Notify: `bun agent:send <parent> "[<CODES>] handoff: PR #<n> at <sha7>; gates …; blockers …"` (parent from `.pu/{{name}}/agents/<your-agent-id>.json` in the main checkout; with no parent, tell the user). agent:send confirms the text was submitted. Send it once: if agent:send reports it NOT confirmed, check `pu logs <parent>` for your message before resending; never resend blind (pu can lose or duplicate typed text, PurePoint#162).
8. Verify: `gh pr view <n> --json headRefOid` equals the SHA from step 1, the handoff page names it, and the tasks read In Review. Reply with the PR URL, handoff URL, SHA and gate results.
   }

Commands {
🤝 /handoff [task codes…] - run every step above for the current branch
}
