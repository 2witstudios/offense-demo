---
name: epic-pipeline
description: >
  Run a new epic through its explicit stages: plan draft, automated external plan review,
  owner approval, tasking, orchestration. Stops only at owner approval and at human-only leaves.
  Use when the owner asks for a new epic, feature area or retrospective remediation, or says "/epic-pipeline".
---

# Epic pipeline

Repository-owned. It exists so the owner stops being the message bus: each stage runs on
from the previous one, and the owner is asked exactly once, at approval. Codex and OpenCode sessions
follow this file too; AGENTS.md points here.

Constraints {
AGENTS.md governs everything below; PageSpace artifact rules apply (Plans, Prompts, Reviews, one folder per epic).
Every drive page and channel named below (Plans, Prompts, Reviews, Issues, Pending decisions, the Library contracts and loops, Epic Updates) is found by its id in `project.config.json` (`pagespace.pages`, `pagespace.channels`); never hard-code or guess an id. A `null` id means the drive is not bootstrapped: run `bun drive:bootstrap` first.
Never task, prompt or spawn before the owner approves the reviewed plan.
A decision you make on the owner's behalf at any stage is recorded with `bun decision:record "<decision>" --context <pageId> --why "<reason>"`; it stays open until confirmed or overruled. Never bury one in a page as "please confirm".
Stop only at the owner-approval point and at human-only leaves (deploy rail, production data, identities, secrets). Everything else runs on.
}

Stages {

1. Plan draft
   Write `Plan — <epic>` in Plans/<Epic>: why, owner decisions, design, sequencing, out of scope, constraints.
   Read every accepted ADR the plan touches. Take ADR and migration numbers from `bun adr:next`, never from memory.
   Declare prerequisites (ADR, contract, leaf, PR) explicitly; leaves that depend on them are sequenced, not parallel.

2. Automated external plan review
   `bun plan:review <planPageId> > <scratchpad>/plan-review-<epic-slug>.md` runs Codex read-only with AGENTS.md and the ADR index.
   Publish its output as `Plan review — <epic> (codex)` in Reviews/<Epic>, mentioning the plan.
   CHANGES REQUESTED => revise the plan and review again until the review approves. Take a disagreement to the owner only when it is a decision only the owner can make (scope or intent), never because of a round count.

3. Owner approval (the one stop)
   Send the owner the plan link, the review verdict and every open decision (`bun decision:record` ids) in one message to Epic Updates.
   Wait. The owner's approval, with the date, is recorded on the plan page. Anything the owner changes goes into the plan before tasking.

4. Tasking
   Create the epic, phases and leaves with `bun board:create` (criteria as "Given X, should Y"; Related pages: plan, prerequisites on a `Prerequisite:` line).
   Before creating each leaf, check it for superseded terms (policy/superseded-terms.json).
   Human-only leaves are marked so in their title and never delegated.

5. Orchestration
   Follow the Library "Orchestrator stage loop": `bun board:stale`, read Issues, commit Ready leaves, write prompts from the Builder and Reviewer contracts, spawn with `pu spawn`, reviews with `/review`, loops with the Library "Converge loop".
   Stop again only at a human-only leaf or a decision only the owner can make; everything else continues.
   }

Commands {
/epic-pipeline <epic name or source page> - run the stages from the first one not yet done
}
