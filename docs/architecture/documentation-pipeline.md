# Canvas documentation pipeline

PageSpace Canvas pages in the `Offense Demo` drive are the canonical published artifacts for technical
documentation, user-facing documentation, and blog posts. Git is the evidence
source: commits, pull requests, changed files, tests, releases, and task IDs
are sent to PageSpace as a versioned event envelope.

The documentation tree starts at the top-level `Documentation` folder in that
drive. It is not a separate drive and new content must be created below this
folder. The `Documentation Agent` lives in the sibling `Agents` folder beside
the Scrum Master, Builder, and Reviewer agents, and owns the page discovery and
creation workflow. The drive, folder and agent ids are read from
`project.config.json` (`pagespace.*`), which `bun drive:bootstrap` fills in;
nothing in the repository hard-codes a PageSpace id.

## Event flow

1. A merge or release produces a structured documentation event. Free text
   from the trigger (title, body, branch) is sanitized and scanned for
   instruction-smuggling; flagged text sets `textRisk: flagged` on the event
   and is routed to review-only handling.
2. Deterministic classification selects technical docs, user docs, blog, or a
   no-op. Conventional-commit prefixes dominate generic keyword scanning, and
   a `!` bang or breaking/security keywords raise the change kind. A bug fix
   with no changed contract must not create documentation work.
3. The local Bun CLI or CI invokes the PageSpace Documentation Agent in the
   existing drive using the drive-scoped PageSpace credential
   (`PAGESPACE_TOKEN`), through the agent consult route
   (`scripts/docs-consult.ts`). Each routed pipeline is its own consult, its
   own conversation, and its own run record, and pipelines are consulted one
   at a time: two consults in flight at once were both cut off. Before each
   consult, dispatch reserves that run's row in the Documentation Runs sheet. The question
   leads with that pipeline's versioned prompt, pre-fills every run-record key
   from trusted CI context, and carries the event last in a nonce-fenced block
   marked untrusted. A consult runs an agent, so it is never retried
   in-process.
   Dispatch waits for the run to answer, but the socket is not the receipt:
   the route persists the question before the run and the answer after it,
   and the answer can be lost on its way back. On a dropped connection or a
   gateway 5xx (including a 5xx whose body is lost mid-read), dispatch reads
   that conversation instead; a status below 500 is final even when its body
   is lost, so a 409 still reads as already dispatched. An answer there is
   success; a conversation that two successful reads find missing (or one at
   the deadline) means the request almost certainly never landed. A
   conversation that cannot be read proves nothing, so it is polled to the
   deadline like one still unanswered; either is then reported as a failure,
   though the run may finish late and still rewrite its reserved row. A 5xx
   carrying the consult route's own JSON error is different: the route
   answers only once its run has stopped, so dispatch reads the conversation
   (once more if it reads empty or cannot be read) and, finding no answer,
   fails at once naming the receipt row and a targeted replay instead of
   polling to the deadline. Each consult waits up to 20 minutes and all of
   them share a 42-minute budget counted from the start of the 45-minute CI
   job (the job's first step records when it ends), so the step fails and
   the incident posts before the job is cancelled. Each consult stops 30
   seconds before the budget does, reserving time to read its conversation,
   and a pipeline starts only while it would get time of its own, checked
   again after its row is reserved; one left with none is reported unsent,
   naming its row and the replay that reaches it.
   Any refusal or failure posts to the incidents channel so a lost event is
   loud, not silent.
   Fork PR merges cannot carry secrets, so they post a skip notice instead and
   are replayed manually.
4. The agent lists the Documentation folder, finds the registered page, and
   creates a child page when no suitable page exists.
5. The agent edits a review Canvas or review revision, not an unrelated page.
6. Accuracy, adversarial, prose, and anti-slop checks validate the candidate.
7. Publication follows the risk policy executed by `bun docs:policy`;
   breaking and security changes additionally require recorded human
   sign-off.

Replay is always safe. Each consult is addressed by a conversation id derived
from the event's `idempotencyKey` (`repository:commit:eventType`) and the
pipeline, and PageSpace refuses an already-taken id with 409, which dispatch
reports as `already-dispatched`. A failed workflow can be re-run, or
`bun docs:dispatch` invoked again locally, without running the agent twice.
A run that was cut off still holds its id, so it is replayed under the next
attempt's id with `DOC_REPLAY_ATTEMPT=1` (then `2`, …); the reconciler is what reveals
such a run, as a pipeline with no run record.

## Data boundary

Event envelope text is untrusted data, never instructions for the agent. The
registered prompts (`bun docs:prompt <pipeline>`, versioned in
`scripts/docs-prompts.ts`) instruct agents to treat envelope fields as data,
to record an injection finding, and to stop when the text attempts to change
their rules. Flagged events never auto-publish.

## Canvas contract

Each canonical page should retain stable semantic sections and a provenance
manifest. Content updates must preserve the page's visual language and update
only affected sections where possible. The manifest records the source commit,
changed paths, task IDs, prompt and validation versions, content/source hashes,
publication state, and invalidation history.

Page writes use optimistic concurrency: a write must carry the
`expectedRevision` observed on the page, and it is applied only when it still
matches the page's current revision. A mismatch means another event interleaved;
the agent re-reads and re-plans instead of overwriting.

Recommended states are `fresh`, `needs-review`, `stale`, `invalid`, and
`superseded`. Deleted or renamed source behavior invalidates dependent sections;
an unrelated bug fix leaves them unchanged.

Manifests are verified, not trusted: `bun docs:verify` checks that the
manifest echoes the event's `repository@commit` and prompt version, and that
cited paths (optionally pinned as `path@commit`) resolve in the repository.

## Scheduled maintenance

Merge-triggered workflows create or update content. Scheduled PageSpace
workflows maintain it:

- accuracy audit: compare claims, examples, links, and source anchors with the
  current repository;
- adversarial review: try invalid inputs, missing permissions, retries, moved
  resources, and clean-environment workflows;
- prose review: improve clarity and reader task completion without changing
  facts;
- anti-slop review: remove generic introductions, repetition, unsupported
  claims, and templated AI phrasing;
- consistency review: detect contradictory terminology and behavior across
  pages;
- publication QA: check rendered Canvas layout, mobile behavior, metadata, and
  public links.

Review workflows write findings and create tasks before making high-risk edits.
Low-risk prose fixes may be applied to a review revision. A successful no-op is
also recorded as a run result. A run that produces empty, truncated, or timed-
out output is recorded with status `failed` or `partial`; such runs never edit
a page beyond what was already validated, and never publish.

## Safety rules

- PageSpace writes are idempotent by repository, commit, event type, and stable
  documentation key, and are guarded by the revision contract above.
- The PageSpace token is server-only and never included in logs or Canvas
  content; it is only ever sent over HTTPS. Channel webhooks are HTTPS-only
  and signed per payload.
- AI agents must cite source paths and commits for technical claims;
  `bun docs:verify` rejects citations that do not resolve.
- Published pages are not rewritten when source evidence conflicts; they are
  marked stale and routed to review.
- Blog publication requires an explicit blog classification or task marker and
  remains a draft until explicitly approved.
- Breaking and security documentation requires recorded human sign-off before
  publication, matching the repository's human-only sign-off rule for
  production-facing changes.
