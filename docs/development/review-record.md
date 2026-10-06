# Review records

A review record is the durable artifact of reviewing one change. It lives in
the Offense Demo PageSpace drive, under `Reviews/<Epic>`, not in the
repository — point-in-time documents rot into misinformation when committed
at the root. The template below is the contract; keep sections in this order.

The record is also what gates autonomous merges. Its page title ends
with the full 40-character head SHA, and its `Candidate:` line names that
SHA, the PR, the builder the PR body declares and the reviewer. When the
record's link lands on the PR, the review-record workflow reads it and sets
the `review-record` check through the review-record GitHub App. The check
passes only when all of these hold:

- the SHA is exactly the PR's head
- the builder matches the PR's `Builder:` line
- the reviewer is someone else
- the verdict approves

Nobody sets that status by hand. The owner may merge before the record
exists. The merged tasks then wait in **Merged** until the record grants
Done.

## Setting up the review-record App

`bun github:review-app` (owner only; the wizard offers it right after the
first push) sets the gate up with the two browser clicks GitHub requires.
`--dry-run` prints every step; `--name <app name>` overrides the default
`<repo>-review-record` (at most 34 characters, tagged with random hex when
that name is taken).

1. It serves a one-shot page on `127.0.0.1` that posts an App manifest to
   GitHub (your account's App settings, or the organization's when an
   organization owns the repository). You click **Create GitHub App**.
2. GitHub redirects back to `127.0.0.1/callback` with a code and the run's
   random `state` (any other state is refused). The code is exchanged with
   `POST /app-manifests/{code}/conversions` for the App id, slug and
   private key. The key is held in memory only: never printed, logged or
   passed as an argument.
3. It limits the `review-record` environment to `main` and stores the key
   there as the `REVIEW_RECORD_APP_KEY` secret (`gh secret set`, key on
   stdin), so no workflow on another branch can read it. On a private
   repository without a paid plan GitHub has no environments; the key then
   becomes a repository secret and the command says why that is weaker.
4. It opens the App's install page. You click **Install** on this
   repository. It polls `GET /repos/{repo}/installation` as the App (an
   RS256 JWT signed with the key) for up to ten minutes.
5. Only once the App is installed does it set the `REVIEW_RECORD_APP_ID`
   variable. The workflow's gate job enforces only when both exist, so an
   interrupted run leaves PRs skipping with a notice, never failing red.
6. It runs `bun github:rules --apply` so `review-record` is a required
   check from this App, or, on a private repository on a free plan,
   explains why GitHub will not enforce it.

The App asks for exactly what the workflow's token is minted with, and
nothing else (`REVIEW_APP_PERMISSIONS` in
`scripts/github-review-app-plan.ts`; a test pins them to the
`permission-*` inputs of `.github/workflows/review-record.yml`):

| Permission            | Used by                                                  |
| --------------------- | -------------------------------------------------------- |
| `statuses: write`     | setting the `review-record` commit status on the PR head |
| `pull_requests: read` | reading the PR's live head SHA and its `Builder:` line   |
| `issues: read`        | reading the PR comments that link the record             |
| `metadata: read`      | granted to every App                                     |

It has no webhook and subscribes to no events. Rerunning is safe: when
the id variable and the key secret both exist it reports and stops;
`--force` creates a new App (delete the old one under the owner's
**Settings → Developer settings → GitHub Apps**).

**Self-check before posting the verdict.** After publishing the
record, run `bun review:check <recordPageId> --pr <n> --dispatch` and fix the
record until it passes, before posting the verdict comment. It runs the same
`verifyReviewRecord` decision the live check runs, against the record page
and the PR's live head SHA and body, and prints `PASS` or the exact refusal.
`--dispatch` re-runs the live status once it passes, so a red status left by
an earlier comment (posted while the record page existed but was still being
written) does not linger as the final state. A merged PR whose branch no
longer carries the reviewed SHA can be checked with `--sha <sha>` to compare
against the record's own SHA instead of the PR's current head.

```markdown
# Review: <task or PR title> (<branch>)

Candidate: <full head sha> · PR #<n> · Builder: <PR body's Builder id> · Reviewer: <your agent id, or owner>

## Gates run

bun check at <sha>: PASS (format, lint, policy, knip, duplication, invariants, evidence,
typecheck, unit tests, metrics, build) · date
bun test:integration: PASS (<n> pass, 0 fail)
Negative control run: yes (below)

## Findings

Each finding is CONFIRMED (reproduced, with the triggering scenario) or
SUSPECTED (what would confirm it). Report only what you verified.

- [ ] blocker · <file>:<line> · <why it must not merge> · <fix commit or PR note>
- [ ] major · <file>:<line> · <why> · <fix>
- [ ] minor · <file>:<line> · <why> · <fix>
- [ ] nit · <file>:<line> · <why> · <fix>

Only check a finding once its fix is verified in the code, not when the
fix is claimed.

Where an unfixed finding goes is decided by one question: is the leaf it
belongs to still open? Open leaf: a follow-up leaf under that phase, always,
whether or not the PR merged. Leaf already Done, or no leaf owns it: an
`ISSUE-n` task in the drive-root `Issues` list (never a GitHub Issue) that
names this record as its origin. Say which in the finding's fix column.

Filing is the reviewer's job, not a suggestion: a record is not finished
while any unfixed finding lacks the page id of the leaf or issue that now
carries it. "Out of scope for this PR" is a reason to file, never a reason
to leave the finding in prose.

## What is good

<two or three specific things worth keeping>

## Privacy & telemetry findings

Check the diff against [ADR 0036](../decisions/0036-privacy-by-design.md)
and [ADR 0037](../decisions/0037-error-tracking-and-product-analytics.md):
every new log field, database/Redis column, `outbox.payload` kind, realtime
topic-family payload field and analytics event is classified and
registered; no `personal`, `sensitive` or `secret` value reaches a log
line, an error report or an analytics event; an `outbox.payload` kind or
realtime topic message carries a `personal`/`public` value only once it is
classified in the inventory, and never a `personal`/`private`, `sensitive`
or `secret` value; every new personal-data column has a retention and
erasure rule, and new client-side tracking declares a consent category.
Findings here follow the
same CONFIRMED/SUSPECTED and severity rules as `## Findings`, and file the
same way when
unfixed.

## Verdict

<n blocker / n major / n minor / n nit> — <APPROVE | APPROVE WITH MINORS | CHANGES REQUESTED>
```

Rules:

- The verdict line is the first line under the last `Verdict` heading,
  and the `review-record` check takes the verdict from nowhere
  else: it accepts exactly `APPROVE` or `APPROVE WITH MINORS`, and refuses
  an approval that counts an open blocker or major.
- A verdict with no findings is refused unless the reviewer ran the
  integration tests and at least one negative control, and the Gates run
  section says so on its own lines: `bun test:integration: PASS` and
  `Negative control run: yes`. The review-record check enforces it too; a
  PASS that says it did not run does not count. Markdown decoration (a
  leading list bullet, backticks around the command, bold) is stripped
  before matching, so a decorated line reads the same as a plain one — but
  "not run" or a question mark anywhere on the line still disqualifies it,
  however it is decorated.
- No pass limit: the reviewer reviews again as many times as it takes to
  reach a verdict, and takes an open disagreement to the orchestrator or
  owner only when it is a decision only they can make, never because of a
  pass count.
- A second-pass review re-verifies the first pass finding by finding
  before approving.
- Record environment gotchas discovered during review (stale builds,
  shared stacks, port collisions) — they are the next reviewer's
  parallel-work traps.
- Plan compliance is a separate discipline: extract every
  "Given X, should Y" acceptance criterion from the task and mark each
  PASS/FAIL/PARTIAL against the diff before writing a verdict.
