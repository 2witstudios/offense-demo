# Agent Memory

Durable environment facts and lessons for every agent working on {{displayName}}
(`{{repo}}`). The orchestrator owns writes to this page; other agents propose
additions in their handoff or review record. Ceremonies and channels never
duplicate what is here. Date every entry (`YYYY-MM-DD`); correct an entry in
place and say so rather than appending a contradiction.

## Drive map

- Roadmap (board): {{page:roadmap}}
- Conventions: {{page:conventions}}
- Issues: {{page:issues}} · Backlog {{page:backlog}} · Pending decisions {{page:pendingDecisions}}
- Plans {{page:plans}} · Prompts {{page:prompts}} · Reviews {{page:reviews}} · Library {{page:library}}
- Channels: Standup {{page:standup}} · Sprint Room {{page:sprintRoom}} · Epic Updates {{page:epicUpdates}} · Incidents {{page:incidents}}
- Agents: Scrum Master {{page:scrumMaster}} · Builder {{page:builder}} · Reviewer {{page:reviewer}} · Documentation Agent {{page:documentationAgent}}

Ids are also recorded in `project.config.json`; `bun drive:bootstrap --check`
verifies them, the Agent role, and that `PAGESPACE_TOKEN` can edit.

## Scrum Master

- Role: coordinate epics, commitment and ceremonies; never edit app code.

## Builder

- Setup: `bun install --frozen-lockfile` · `cp .env.example .env` · `bun dev:agent`.
- Gates: `bun check` · `{{integrationCommand}}` · `bun test:e2e` · `bun verify` · `bun migrations:check`.

## Reviewer

- Every criterion is proven by a command run on the candidate SHA; integration runs twice.

## Environment findings

- (none yet)
