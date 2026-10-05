Installed copies: ~/.claude/skills/task, ~/.codex/skills/task, ~/.config/opencode/skills/task. Upstream: pointguard skills/task/references/plan-template.md. This page is the drive's reference copy; edit upstream, then sync.

# Plan page template

Title: `Plan — <Epic>` (DOCUMENT in `Plans/<Epic>`). Keep sections in this order; omit none.
The Related line gains the epic and delivery-log mentions at tasking, when those pages exist.

```markdown
Planning: 1 — draft
Related pages: @<conventions page>

## Why

<one paragraph: the problem, who has it, what changes when this ships>

## Owner decisions

- <decision already made by the owner, with date>

### Pending decisions

- <DEC-n or open question> — <the default taken meanwhile and why>

## Design

<the approach, the contracts it adds or changes, the ADRs it follows or supersedes>

## Phases

- 1 — Schema — the auth tables exist and migrate twice cleanly
- 2 — Sign-in — a user can sign in with a magic link end to end

## Manifest

Execution-order source of truth. Phase grouping is organizational and never forces
independent work to wait. Edit this table first; the Timeline below is derived from it.

| Leaf     | Title                                                     | Owner            | Depends on                   | Single-writer | Page ID |
| -------- | --------------------------------------------------------- | ---------------- | ---------------------------- | ------------- | ------- |
| AUTH-1.1 | Given the auth schema, should define users and sessions   | Builder          | —                            | migrations    |         |
| AUTH-1.2 | Given the schema, should add verification tokens          | Builder          | —                            | migrations    |         |
| AUTH-1.3 | Given staging secrets, should be provisioned by the owner | Jonathan — human | —                            | —             |         |
| AUTH-2.1 | Given an email, should send a magic link                  | Builder          | AUTH-1.2, AUTH-1.3, ADR 0019 | —             |         |
| AUTH-2.2 | Given a magic link, should create a session               | Builder          | AUTH-1.1                     | —             |         |

## Leaf criteria

- AUTH-1.1
  - Given the auth schema, should define users and sessions with cuid2 ids.
  - Given `bun db:generate`, should produce one reviewed forward migration.
- AUTH-1.2
  - …

## Timeline

Derived from the Manifest (dependency order, no dates). Builder cap: 3.

- **Stage 1 — parallel (2 lanes); gate: none**: AUTH-1.1 · AUTH-1.3
- **Stage 2 — parallel (2 lanes); gate: none**: AUTH-1.2 · AUTH-2.2
- **Stage 3 — sequential; gate: AUTH-1.3, ADR 0019**: AUTH-2.1

Critical path: AUTH-1.1 → AUTH-1.2 → AUTH-2.1 (3 leaves)
Human gates: AUTH-1.3
Walking skeleton: none

## Out of scope

- <what this epic deliberately does not do, and where it goes instead>

## Constraints

- <repo rules this epic must honour: boundaries, single writers, gates, policy>

## Revisions

- Revision 1 (<YYYY-MM-DD>): initial plan.

Approved by <owner>, <YYYY-MM-DD>.
```

In the example, AUTH-1.1 and AUTH-1.2 share the migrations writer, so AUTH-1.2 gets a
single-writer edge from AUTH-1.1 and lands in stage 2. AUTH-1.3 is human-only: it is never set
Ready or delegated, and it gates AUTH-2.1 together with ADR 0019.

## Delivery log page

Title: `Delivery log — <Epic>` (DOCUMENT in `Plans/<Epic>`). Newest entry first.

```markdown
Related pages: @Plan — <Epic> · @Epic — <Name>

- <YYYY-MM-DD>: 2/5 leaves Done · timeline stage 2 of 3 · Ready: AUTH-2.2 · In progress: AUTH-1.2 · In review: — · Blocked: — · Human gates open: AUTH-1.3 · Drift: none
```
