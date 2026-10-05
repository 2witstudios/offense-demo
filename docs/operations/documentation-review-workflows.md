# PageSpace documentation review workflows

The documentation pipeline has two trigger classes:

- merge and release events request content changes;
- scheduled PageSpace workflows audit and maintain published Canvases.

Scheduled reviews must write findings to the review queue before changing a
published page. A no-op is a valid result and should be recorded.

## Page setup

All documentation content lives in the existing `Offense Demo` drive under the
top-level `Documentation` folder. The Documentation Agent lives under the
drive's `Agents` folder with the Scrum Master, Builder, and Reviewer. The
repository records the drive and folder IDs in
`PAGESPACE_DOCUMENTATION_DRIVE_ID` and
`PAGESPACE_DOCUMENTATION_ROOT_PAGE_ID`.

New documentation Canvases are created as children of the appropriate hub page.
Merge and release events reach the Documentation Agent through
`bun docs:dispatch`, which consults it directly with the drive-scoped
`PAGESPACE_TOKEN`. Scheduled PageSpace workflows run the periodic reviews
directly against the Documentation tree.

| Agent page           | Pipeline             | Cadence                                            | Default action                                      |
| -------------------- | -------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Accuracy Auditor     | `accuracy-review`    | Daily for recently changed pages; weekly full scan | Mark stale or invalid; create findings              |
| Adversarial Reviewer | `adversarial-review` | Weekly                                             | Create counterexamples and tasks                    |
| Prose Editor         | `prose-review`       | Weekly                                             | Draft low-risk prose corrections                    |
| Anti-Slop Reviewer   | `anti-slop-review`   | Weekly                                             | Draft targeted rewrites only                        |
| Consistency Auditor  | `prose-review`       | Weekly                                             | Report conflicting terminology or behavior          |
| Publication QA       | `accuracy-review`    | After publication and weekly                       | Check links, metadata, rendering, and mobile layout |

## Prompt and data boundary

Prompts are versioned in the repository and delivered by
`bun docs:prompt <pipeline>`; a run record must echo the version it used. The
registered prompts instruct every agent that event envelope fields (titles,
bodies, branch names, task IDs) are untrusted data, never instructions. An
event whose text was flagged by the dispatch scanner arrives with
`textRisk: flagged` and must be handled as review-only: the agent records an
injection finding and does not publish.

## Failure-path contract

A run that ends with empty, truncated, or timed-out output is a `failed` run;
a run that completed only part of its scope is `partial`. Failed and partial
runs:

- write a valid run record with the corresponding status;
- create findings describing what could not be verified;
- never publish, and never leave a page half-edited.

Payloads (events and run records) must pass the repository's contract
validation in `scripts/docs-contracts.ts` before use; an invalid payload is a
failed run, not a warning.

## Accuracy prompt contract

The accuracy agent must check claims against current source code, tests,
protocol schemas, configuration, and linked PageSpace evidence. Each finding
must contain:

```text
page ID
section ID
claim
source checked
current evidence
severity: blocker | major | minor | editorial
recommended action
```

It must not replace a published page when evidence conflicts. It marks the
page `stale` or `invalid`, records the source conflict, and creates a review
task instead.

## Adversarial prompt contract

The adversarial agent tries to disprove the page by checking missing
permissions, invalid input, retries, moved or deleted resources, clean
environment setup, mobile behavior, and the documented task order. It reports
counterexamples; it does not invent fixes or silently rewrite behavior.

## Prose and anti-slop prompt contract

These agents may edit a review revision, but must preserve factual claims and
source anchors. They should remove generic introductions, repeated summaries,
unsupported certainty, vague benefits, filler, fake specificity, and
changelog-like prose. They must not flatten intentional product voice or
redesign a Canvas during a prose-only change.

## Publication policy

Publication decisions are executed by `bun docs:policy`, which takes the
validated event, the finding severities, the run status, and any recorded
approvals, and returns `publish`, `revision`, `review`, or `block`:

- `block`: a blocker finding invalidates the page; mark it `invalid` and
  notify the documentation channel.
- `review`: a major finding, injection-flagged text, a failed or partial run,
  or a breaking/security change without recorded human sign-off.
- `revision`: minor or editorial findings batch into a review revision; blog
  output without explicit approval stays a draft.
- `publish`: no gating condition applied.

Cross-page contradictions require an authoritative-page decision. Successful
no-op runs record the reviewed page count and source snapshot.

## Run record

Each workflow writes one run record per run to the Documentation Runs sheet.
The schema is enforced by the repository (`scripts/docs-contracts.ts`), and
`scripts/docs-runs-sheet.ts` is the only statement of the sheet's layout: one
field per column (header row = field names), counts as integers, objects and
arrays as JSON. Dispatch reserves each run's row before the consult by
appending it with every trusted key and `status: failed`, so concurrent runs
never share a row and a run that never finishes stays visible; the agent
rewrites that row only. Never delete a Runs row: deleting shifts every row
below it, so an in-flight run would rewrite someone else's receipt. Correct a
bad row in place instead. The consult prompt is generated from that layout, and
`bun docs:reconcile` reads the sheet back through it, failing on a drifted
header or an invalid row rather than skipping it:

```json
{
  "runId": "...",
  "workflow": "accuracy-review",
  "startedAt": "...",
  "completedAt": "...",
  "scope": { "pageIds": [], "changedSince": "..." },
  "pagesReviewed": 0,
  "findings": [],
  "autoFixed": 0,
  "tasksCreated": 0,
  "pagesInvalidated": 0,
  "promptVersion": "docs-prompt-v3",
  "sourceSnapshot": "repository@commit",
  "status": "complete | failed | partial",
  "baseRevision": "...",
  "resultingRevision": "...",
  "idempotencyKey": "repository:commit:eventType",
  "notes": "..."
}
```

`baseRevision` records the page revision the run observed before editing;
`resultingRevision` records what the write produced. Both together make
interleaved writes detectable and replayable. Those two, `idempotencyKey`
(present when an event triggered the run) and `notes` (one sentence on what
changed, or why nothing did) are optional.

`bun docs:reconcile --since 24h` recomputes the events merged pull requests
should have produced and lists every routed pipeline with no run record, keyed
on `(sourceSnapshot, workflow)`. It is report-only: it posts nothing and exits 0
whatever it finds, but a refused read or an invalid row exits non-zero.

The repository supplies the event and every run-record key; the agent reads
the Canvas pages and prior run history itself. No token, webhook secret, or
other raw credential may be written into a PageSpace page or log.

## Replaying a lost event

Dispatch is idempotent by `repository:commit:eventType`, so replays are safe:
each pipeline's consult is addressed by an id derived from that key, and
PageSpace refuses a taken id with 409 rather than running the agent again.

1. Re-run the failed workflow from the Actions tab, or run
   `bun docs:dispatch` locally with the same `DOC_*` variables from the
   merge or release, plus `PAGESPACE_TOKEN`, but without
   `DOC_BUDGET_ENDS_AT`: that is the job's absolute deadline, already past
   once the job has ended, and without it the budget counts from when the
   local dispatch starts. Pipelines that already ran report
   `already-dispatched`.
2. If a pipeline reports `already-dispatched` but `bun docs:reconcile` still
   lists it as uncovered, its earlier run holds its id without having
   written a run record: it was cut off, or it is still going. If the
   failure dispatch reported for it says the consult failed in PageSpace,
   that run has ended: replay at once. Otherwise wait until that run's
   conversation has an answer or an hour after the failure dispatch reported
   for it (90 minutes after its dispatch if none was reported, which covers
   the 20-minute consult window). Replay with `DOC_REPLAY_ATTEMPT=1` (then
   `2`, …), which addresses a fresh conversation, and set `DOC_PIPELINES` to
   just the uncovered pipelines (comma-separated) so the healthy ones are
   not run again. A name the event does not route to is rejected.
   A dispatch failure names the replay to use, and its receipt row when one
   was reserved; it also lists the pipelines that did settle, with their
   conversations, so an `already-dispatched` one beside it falls under the
   step above. A row that is no longer failed (complete or partial) is a
   receipt, so its pipeline needs no replay. A consult that failed in
   PageSpace (the route itself answered with its own error) has ended,
   whether or not its conversation could then be read: replay it with the
   next attempt at once if its row is still failed, since a run can record
   its receipt before its answer is lost. Any other consult that did not
   answer in time, or whose conversation could not be read after a gateway
   error or dropped connection, may still be running: PageSpace sets no time
   limit on a run, and its row stays failed until it ends. If the row is no
   longer failed, nothing is lost; otherwise replay with the next attempt
   once the named conversation has an answer or an hour after the failure,
   whichever comes first (PageSpace caps a consult run at 20 tool steps, and
   the longest seen took about 25 minutes). Replaying sooner can start a
   second run beside a live one; never replaying can strand a dead one. A
   consult left unsent, because the budget ran out (before or after its row
   was reserved) or reserving its row failed, was never sent, so its id is
   unused: replay it with the same attempt. A consult that never reached
   PageSpace (successful reads found no conversation) also gives the same
   attempt, since its id was almost certainly never used; but PageSpace
   claims an id before it saves the question, so if that replay reports
   `already-dispatched` while `bun docs:reconcile` still lists the pipeline,
   the request landed late: replay with the next attempt once the
   conversation named in the failure has an answer or an hour after the
   failure, whichever comes first. A 4xx refusal other than 409 came before
   any run started: fix its cause (an expired token, a rate limit, a
   malformed input), then replay with the same attempt.
3. If a merged fork PR skipped the event (fork runs carry no secrets), run the
   same dispatch from a trusted checkout and delete the skip notice in
   incidents after it succeeds.
