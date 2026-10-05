#!/usr/bin/env bun
/**
 * bun review:check <recordPageId> --pr <n> [--sha <sha>] [--dispatch]
 * (ISSUE-122)
 *
 * Runs the exact `verifyReviewRecord` decision the review-record GitHub
 * check runs, against a specific record page and the PR's live head SHA and
 * body, so a reviewer sees the check's exact answer — PASS or the exact
 * refusal — before posting a verdict comment, instead of finding out from a
 * red status after the fact. Exits 1 on refusal.
 *
 * --sha overrides the head SHA compared against, for a merged PR whose
 * live head SHA no longer matches the SHA the record reviewed.
 * --dispatch re-runs the live status once this passes
 * (`gh workflow run review-record.yml -f pr=<n>`), turning a transient red
 * left by a comment posted mid-draft (.github/workflows/review-record.yml)
 * into the final state.
 */
import { loadProjectConfig } from './project-config';
import {
  declaredBuilder,
  linkedPageIds,
  reviewRules,
  verifyReviewRecord,
  type PullRequest,
} from './review-record';
import { fetchPullRequest, gh, ghJson, readRecords } from './review-record-io';

const USAGE =
  'usage: bun review:check <recordPageId> --pr <n> [--sha <sha>] [--dispatch]';

export type CheckArgs =
  | { readonly error: string }
  | {
      readonly recordPageId: string;
      readonly pr: number;
      readonly sha: string | undefined;
      readonly dispatch: boolean;
    };

export function parseCheckArgs(argv: readonly string[]): CheckArgs {
  const [recordPageId, ...rest] = argv;
  const prIndex = rest.indexOf('--pr');
  const pr = prIndex === -1 ? NaN : Number(rest[prIndex + 1]);
  if (
    !recordPageId ||
    recordPageId.startsWith('-') ||
    !Number.isInteger(pr) ||
    pr < 1
  )
    return { error: USAGE };
  const shaIndex = rest.indexOf('--sha');
  return {
    recordPageId,
    pr,
    sha: shaIndex === -1 ? undefined : rest[shaIndex + 1],
    dispatch: rest.includes('--dispatch'),
  };
}

/**
 * Every page id this check reads: the record page being checked, plus
 * whatever the PR's body and comments already link, so an already-posted
 * second record still counts against the same "every record must approve"
 * rule the live check applies.
 */
export function checkedRecordIds(
  recordPageId: string,
  linked: readonly string[],
): readonly string[] {
  return [...new Set([recordPageId, ...linked])];
}

/** The gh command --dispatch runs once the record passes. */
export const dispatchCommand = (prNumber: number): readonly string[] => [
  'workflow',
  'run',
  'review-record.yml',
  '-f',
  `pr=${prNumber}`,
];

// ------------------------------------------------------------------- edges

export async function main(
  repository: string,
  args: {
    readonly recordPageId: string;
    readonly pr: number;
    readonly sha: string | undefined;
    readonly dispatch: boolean;
  },
): Promise<number> {
  const rules = reviewRules(loadProjectConfig());
  const fetched = fetchPullRequest(repository, args.pr);
  const pr: PullRequest = args.sha
    ? { ...fetched.pr, headSha: args.sha }
    : fetched.pr;
  const builder = declaredBuilder(pr.body);
  process.stdout.write(
    `PR #${pr.number} · builder ${builder ?? 'undeclared'} · head ${pr.headSha.slice(0, 7)}${args.sha ? ' (overridden)' : ''}\n`,
  );
  const ids = checkedRecordIds(
    args.recordPageId,
    linkedPageIds([pr.body, ...fetched.comments], rules),
  );
  const { records, unreadable } = await readRecords(ids, rules.driveId);
  const verdict = verifyReviewRecord(pr, records, unreadable, rules);
  if (verdict.state !== 'success') {
    process.stdout.write(`${verdict.description}\n`);
    return 1;
  }
  process.stdout.write(`PASS: ${verdict.description}\n`);
  if (args.dispatch) {
    process.stdout.write('re-running the live status …\n');
    gh(dispatchCommand(args.pr));
  }
  return 0;
}

if (import.meta.main) {
  const parsed = parseCheckArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  const { nameWithOwner } = ghJson<{ nameWithOwner: string }>([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
  ]);
  process.exitCode = await main(nameWithOwner, parsed);
}
