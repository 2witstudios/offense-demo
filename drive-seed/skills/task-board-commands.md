Installed copies: ~/.claude/skills/task, ~/.codex/skills/task, ~/.config/opencode/skills/task. Upstream: pointguard skills/task/references/board-commands.md. This page is the drive's reference copy; edit upstream, then sync.

# Board commands

Exact `pagespace` recipes for the tasking, validate and sync stages. Where the repo has
`bun board:*` ({{displayName}}), use the equivalent in the last column; it adds hash-checked writes.

Every task is backed by its own TASK_LIST page (`pageId` in the create/list output). Its
subtasks are created on that page, and its body is that page's content.

| Step                        | pagespace                                                                                                                                                                                           | bun board:*                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Status slugs of a list      | `pagespace tasks statuses <listPageId> --json`                                                                                                                                                      | —                                      |
| Existing codes              | `pagespace search text "<PREFIX>-" --drive <driveId> --max-results 200`                                                                                                                             | `bun board:read`                       |
| Create a task               | `pagespace tasks create <parentListPageId> --title "<title>" --priority <medium\|high> --status pending [--assignee <humanUserId>] --json` → keep `pageId` (Manifest Page ID)                       | `bun board:create`                     |
| Resolve a taskId            | `pagespace tasks list <parentListPageId> --json` → the task whose `pageId` matches                                                                                                                  | `bun board:read`                       |
| Read a body                 | `pagespace pages read <pageId> --raw` (note the line count)                                                                                                                                         | `bun board:read`                       |
| Write a body                | `pagespace pages replace-lines <pageId> --start 1 --end <lines> --expect-lines <lines> --file <scratch>`; for a new page, read it first and use the line count it reports (an empty body is 1 line) | `bun board:replace`                    |
| Add a Related entry         | read, append one `<li>` inside the Related pages `<ul>`, write back                                                                                                                                 | `bun board:relate <page> <Label> <id>` |
| Order siblings              | `pagespace tasks reorder <parentListPageId> <taskId> <position>` (0-based)                                                                                                                          | —                                      |
| Set status                  | `pagespace tasks update <parentListPageId> <taskId> --status <slug>`                                                                                                                                | `bun board:status <taskPageId> <slug>` |
| Read back                   | `pagespace tasks list <listPageId> --json` (recurse into each `pageId` with `subTaskCount > 0`)                                                                                                     | `bun board:read`                       |
| Create a folder or document | `pagespace pages create "<title>" FOLDER\|DOCUMENT <parentId> --drive <driveId> --json`                                                                                                             | —                                      |
| Post to a channel           | `pagespace channels send <channelId> "<message>"`                                                                                                                                                   | —                                      |
| Verify an id                | `pagespace pages read-details <id>`                                                                                                                                                                 | —                                      |

Rules:

- Write bodies from a scratch file named for the epic and page (`<scratchpad>/epic-<slug>-<pageId>.html`), never a shared name.
- Re-read a page immediately before replacing it and pass `--expect-lines`; if it changed, read again and redo the edit.
- Statuses: `pending` (To Do) → `ready` (committed) → `in_progress` → `in_review` → `completed` (Done, from an independent review only); `blocked` at any point. Use the list's own slugs from `tasks statuses`.
- Never `--due`. `--assignee` only for the named human on a human-only leaf, never an agent.
- `tasks update` and `tasks reorder` take the taskId, resolved from `tasks list` by pageId; mentions, `board:*` and `pages *` take the pageId.

## Leaf body (HTML, as PageSpace stores it)

```html
<ul>
<li>
Given X, should Y.
</li>
<li>
Given `bun check`, should pass.
</li>
</ul>
<h3>
Related pages
</h3>
<ul>
<li>
Plan: <a class="mention" data-mention-type="page" data-page-id="<planPageId>">@Plan — <Epic></a>
</li>
<li>
Conventions: <a class="mention" data-mention-type="page" data-page-id="<conventionsPageId>">@Task artifacts and linking</a>
</li>
<li>
Prerequisite: <a class="mention" data-mention-type="page" data-page-id="<leafPageId>">@AUTH-1.2 — Given …</a>
</li>
<li>
Prerequisite: ADR 0019 (token and secret ownership)
</li>
<li>
Prerequisite (single-writer migrations): <a class="mention" data-mention-type="page" data-page-id="<leafPageId>">@AUTH-1.1 — Given …</a>
</li>
</ul>
```

Escape `&`, `<`, `>` and `"` in criteria and titles. Handoffs, PRs, reviews and follow-ups are
appended to the same Related pages block later by /handoff, /pr and /review.
