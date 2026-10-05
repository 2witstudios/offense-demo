#!/usr/bin/env bun
/**
 * The review-record status. A PR's head SHA gets `review-record`
 * success only from a published independent review record for that exact
 * SHA: its Candidate line names the SHA, the PR, the builder the PR body
 * declares and a different reviewer, and its verdict approves. Only the
 * review-record GitHub App may set the status (the ruleset pins it), and
 * the App's key lives in an environment that only main can use, so this
 * verifier, run from main by .github/workflows/review-record.yml, is the
 * only code that can mint it.
 */
import { appendFileSync } from 'node:fs';
import {
  driveUrl,
  loadProjectConfig,
  requireDriveId,
  type ProjectConfig,
} from './project-config';
import {
  commentBodies,
  fetchPullRequest,
  ghJson,
  readRecords,
  recordFromPage,
  type PullRequest,
  type RecordPage,
} from './review-record-io';

export { commentBodies, recordFromPage, type PullRequest, type RecordPage };

export type Verdict = {
  readonly state: 'success' | 'failure' | 'pending';
  readonly description: string;
  readonly recordId?: string;
};

/**
 * What the verifier reads from project.config.json: the drive whose pages
 * count as records, the PageSpace host links name, and the integration gate
 * a no-findings verdict must show as passed.
 */
export type ReviewRules = {
  readonly driveId: string;
  readonly apiUrl: string;
  readonly integrationCommand: string;
};

export const reviewRules = (config: ProjectConfig): ReviewRules => ({
  driveId: requireDriveId(config),
  apiUrl: config.pagespace.apiUrl,
  integrationCommand: config.gates.integrationCommand,
});

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const pageLink = (rules: Pick<ReviewRules, 'driveId' | 'apiUrl'>): RegExp =>
  new RegExp(
    String.raw`${escapeRegExp(new URL(rules.apiUrl).host)}\/dashboard\/${escapeRegExp(rules.driveId)}\/([a-z0-9]{20,32})`,
    'g',
  );
const CANDIDATE =
  /Candidate:\s*([0-9a-f]{40})\s*·\s*PR #(\d+)\s*·\s*Builder:\s*(\S+)\s*·\s*Reviewer:\s*(\S+)/;
const VERDICT_HEADING = /^#*\s*Verdict$/;
const VERDICT_LINE =
  /^(\d+) blockers? \/ (\d+) majors? \/ (\d+) minors? \/ (\d+) nits? — (.+)$/;
const APPROVALS = new Set(['APPROVE', 'APPROVE WITH MINORS']);

export function linkedPageIds(
  texts: readonly string[],
  rules: Pick<ReviewRules, 'driveId' | 'apiUrl'>,
): readonly string[] {
  const link = pageLink(rules);
  return [
    ...new Set(
      texts.flatMap((text) => [...text.matchAll(link)].map((m) => m[1])),
    ),
  ];
}

export const declaredBuilder = (body: string): string | undefined =>
  /^\s*Builder:\s*(\S+)/m.exec(body)?.[1];

const plainText = (content: string): string =>
  content.replace(/<[^>]+>/g, '\n').replaceAll('&amp;', '&');

const textLines = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

/**
 * The record's verdict: the line right after its last Verdict heading and
 * nothing else, so findings that quote a verdict or the contract's list of
 * verdicts never count.
 */
function finalVerdict(text: string) {
  const lines = textLines(text);
  const heading = lines.findLastIndex((line) => VERDICT_HEADING.test(line));
  const match =
    heading === -1 ? null : VERDICT_LINE.exec(lines[heading + 1] ?? '');
  if (!match) return undefined;
  const [blockers, majors, minors, nits] = match.slice(1, 5).map(Number);
  return { blockers, majors, minors, nits, verdict: match[5].trim() };
}

const GATES_HEADING = /^#*\s*Gates run$/;
const NEXT_HEADING =
  /^#*\s*(?:Findings|Criteria|Negative controls?|Checked and found sound|What is good|Verdict)$/;

/**
 * Strips Markdown decoration a reviewer might reasonably wrap a Gates run
 * line in (a leading list bullet, backticks, bold) so the line reads the
 * same as its plain form; it never touches "not run" or "?", which must
 * still disqualify the line however it is decorated.
 */
const stripDecoration = (line: string): string =>
  line
    .replace(/^(?:[-*]|\d+\.)\s*/, '')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .trim();

/**
 * Gates run evidence: a line of the Gates run section itself that passed,
 * never one quoted elsewhere, and never a PASS that says it did not run.
 */
function gateLine(text: string, gate: RegExp): boolean {
  const lines = textLines(text);
  const start = lines.findIndex((line) => GATES_HEADING.test(line));
  if (start === -1) return false;
  const end = lines.findIndex(
    (line, index) => index > start && NEXT_HEADING.test(line),
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map(stripDecoration)
    .some((line) => gate.test(line) && !/not run|\?/i.test(line));
}

/** Why this record does not approve the PR; undefined when it does. */
function recordProblem(
  pr: PullRequest,
  builder: string,
  text: string,
  integrationCommand: string,
): string | undefined {
  const candidate = CANDIDATE.exec(text);
  if (!candidate)
    return 'The record has no "Candidate: <sha> · PR #n · Builder: … · Reviewer: …" line';
  const [, sha, number, named, reviewer] = candidate;
  if (sha !== pr.headSha)
    return `The record reviews ${sha.slice(0, 7)}, not ${pr.headSha.slice(0, 7)}`;
  if (Number(number) !== pr.number)
    return `The record reviews PR #${number}, not #${pr.number}`;
  if (named !== builder)
    return `The record names builder ${named}; the PR declares ${builder}`;
  return reviewer === builder
    ? `The reviewer ${reviewer} is the builder of this PR`
    : verdictProblem(text, integrationCommand);
}

function verdictProblem(
  text: string,
  integrationCommand: string,
): string | undefined {
  const final = finalVerdict(text);
  if (!final)
    return 'The record has no "n blocker / n major / n minor / n nit — <verdict>" line under Verdict';
  if (!APPROVALS.has(final.verdict))
    return `The verdict is not an approval: ${final.verdict}`;
  if (final.blockers > 0 || final.majors > 0)
    return `The verdict approves with ${final.blockers} blocker and ${final.majors} major open`;
  const clean = final.minors === 0 && final.nits === 0;
  const evidenced =
    gateLine(
      text,
      new RegExp(
        String.raw`^${escapeRegExp(integrationCommand)}:\s*PASS\b(?!\?)`,
      ),
    ) && gateLine(text, /^Negative control run:\s*yes\b/i);
  return clean && !evidenced
    ? `A no-findings verdict needs ${integrationCommand} PASS and a negative control in Gates run`
    : undefined;
}

export function verifyReviewRecord(
  pr: PullRequest,
  records: readonly RecordPage[],
  /** Linked pages that could not be read: any one fails the check. */
  unreadable: readonly string[],
  rules: Pick<ReviewRules, 'integrationCommand'>,
): Verdict {
  const [missing] = unreadable;
  if (missing !== undefined)
    return {
      state: 'failure',
      description: `Linked page ${missing} could not be read; review-record fails closed`,
    };
  const forSha = records.filter(
    (record) =>
      record.title.includes(pr.headSha) ||
      CANDIDATE.exec(plainText(record.content))?.[1] === pr.headSha,
  );
  const [first] = forSha;
  if (!first)
    return {
      state: 'pending',
      description: `No review record for ${pr.headSha.slice(0, 7)} yet`,
    };
  const builder = declaredBuilder(pr.body);
  if (!builder)
    return {
      state: 'failure',
      description: 'The PR body declares no "Builder: <id>" line',
      recordId: first.id,
    };
  const judged = forSha.map((record) => {
    const text = plainText(record.content);
    return {
      record,
      text,
      problem: recordProblem(pr, builder, text, rules.integrationCommand),
    };
  });
  // Every record for this SHA must approve: one reviewer's approval does
  // not outvote another's request for changes.
  const refused = judged.find((entry) => entry.problem !== undefined);
  if (refused)
    return {
      state: 'failure',
      description: refused.problem ?? 'No approving record',
      recordId: refused.record.id,
    };
  const [approved] = judged;
  return {
    state: 'success',
    description: `Independent review by ${CANDIDATE.exec(approved.text)?.[4]}: ${finalVerdict(approved.text)?.verdict}`,
    recordId: approved.record.id,
  };
}

export const APP_NOT_CONFIGURED = 'review App not configured (GRD-6.2)';

/**
 * Whether the review-record App can be used yet. Until the owner creates it
 * (GRD-6.2), the check is skipped with a notice instead of failing every
 * PR; once its id and key exist, verification enforces. The gate itself
 * never sets a status, so it can never report success.
 */
export function reviewAppGate(
  env: Readonly<Record<string, string | undefined>>,
): {
  readonly state: 'enforce' | 'not-configured';
  readonly notice: string | undefined;
} {
  return env.REVIEW_RECORD_APP_ID && env.REVIEW_RECORD_APP_KEY
    ? { state: 'enforce', notice: undefined }
    : { state: 'not-configured', notice: APP_NOT_CONFIGURED };
}

// ------------------------------------------------------------------- edges

export async function main(repository: string, prNumber: number) {
  const config = loadProjectConfig();
  const rules = reviewRules(config);
  const { pr, comments } = fetchPullRequest(repository, prNumber);
  const ids = linkedPageIds([pr.body, ...comments], rules);
  const { records, unreadable } = await readRecords(ids, rules.driveId);
  const verdict = verifyReviewRecord(pr, records, unreadable, rules);
  ghJson([
    'api',
    '-X',
    'POST',
    `repos/${repository}/statuses/${pr.headSha}`,
    '-f',
    `state=${verdict.state}`,
    '-f',
    'context=review-record',
    '-f',
    `description=${verdict.description.slice(0, 140)}`,
    ...(verdict.recordId
      ? ['-f', `target_url=${driveUrl(config)}/${verdict.recordId}`]
      : []),
  ]);
  process.stdout.write(
    `review-record ${verdict.state} for ${pr.headSha}: ${verdict.description}\n`,
  );
}

/** The gate job: prints the notice and writes state for the verify job. */
function runGate(): void {
  const gate = reviewAppGate(process.env);
  if (gate.notice)
    process.stdout.write(`::notice title=review-record::${gate.notice}\n`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `state=${gate.state}\n`);
  process.stdout.write(`review-record gate: ${gate.state}\n`);
}

if (import.meta.main && process.argv[2] === 'gate') runGate();
else if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const prNumber = Number(process.env.REVIEW_PR ?? '');
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isInteger(prNumber) ||
    prNumber < 1
  ) {
    process.stderr.write(
      'review-record: GITHUB_REPOSITORY and a numeric REVIEW_PR are required\n',
    );
    process.exit(2);
  }
  await main(repository, prNumber);
}
