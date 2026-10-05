#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { DocumentationRunRecord } from './docs-contracts';
import { assessEventText } from './untrusted-text';
import {
  createDocumentationEvent,
  parseChangedFiles,
  type DocumentationEvent,
  type DocumentPipeline,
} from './docs-pipeline';
import { DOCUMENTATION_PROMPT_VERSION } from './docs-prompts';
import { runRecordsFromSheet, type SheetRow } from './docs-runs-sheet';
import { extractTaskIds } from './notify-drive';
import { loadProjectConfig, requirePage } from './project-config';
import { pagespaceApi, type PagespaceApiOptions } from './pagespace-docs';

const root = resolve(import.meta.dir, '..');

export type MergedPullRequest = {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly url: string;
  readonly author: string | null;
  readonly mergedBy: string | null;
  readonly repository: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeCommitSha: string;
  readonly mergedAt: string;
  readonly fork: boolean;
  readonly changedFiles: readonly string[];
};

export type UncoveredPipeline = {
  readonly pullRequest: number;
  readonly url: string;
  readonly sourceSnapshot: string;
  readonly pipeline: DocumentPipeline;
};

// The merge workflow sanitizes before it classifies (scripts/dispatch-docs.ts),
// so reconciliation must sanitize in the same order or a long body's keyword
// classifies here and vanishes there.
const eventFor = (
  pullRequest: MergedPullRequest,
): DocumentationEvent | undefined => {
  if (pullRequest.fork) return undefined;
  const assessed = assessEventText({
    title: pullRequest.title,
    body: pullRequest.body,
  });
  const event = createDocumentationEvent({
    eventId: `${pullRequest.id}-${pullRequest.mergeCommitSha}`,
    eventType: 'pull_request.merged',
    occurredAt: pullRequest.mergedAt,
    repository: pullRequest.repository,
    baseRef: pullRequest.baseRef,
    commit: pullRequest.mergeCommitSha,
    pullRequest: {
      number: pullRequest.number,
      title: assessed.title,
      body: assessed.body === '' ? null : assessed.body,
      url: pullRequest.url,
      author: pullRequest.author,
      mergedBy: pullRequest.mergedBy,
    },
    taskIds: extractTaskIds([assessed.title, assessed.body].join(' ')),
    changedFiles: parseChangedFiles(pullRequest.changedFiles.join('\n')),
    promptVersion: DOCUMENTATION_PROMPT_VERSION,
    textRisk: assessed.textRisk,
    textRiskReasons: assessed.reasons,
  });
  return event.classification.pipelines.length > 0 ? event : undefined;
};

export function expectedEvents(
  pullRequests: readonly MergedPullRequest[],
): readonly DocumentationEvent[] {
  return pullRequests
    .map(eventFor)
    .filter((event): event is DocumentationEvent => event !== undefined);
}

export function selectReconcilableMerges<
  T extends { readonly mergedAt: string },
>(input: {
  readonly pullRequests: readonly T[];
  readonly now: number;
  readonly sinceMs: number;
  readonly graceMs: number;
}): readonly T[] {
  const oldest = input.now - input.sinceMs;
  const youngest = input.now - input.graceMs;
  return input.pullRequests.filter((pullRequest) => {
    const mergedAt = Date.parse(pullRequest.mergedAt);
    return (
      Number.isFinite(mergedAt) && mergedAt >= oldest && mergedAt <= youngest
    );
  });
}

// A record only vouches for the workflow that wrote it: a merge routed to two
// pipelines needs two receipts, and a failed run is not a receipt at all.
export function findMissingRuns(input: {
  readonly expected: readonly DocumentationEvent[];
  readonly runRecords: readonly DocumentationRunRecord[];
}): readonly UncoveredPipeline[] {
  const covered = new Set(
    input.runRecords
      .filter((record) => record.status !== 'failed')
      .map((record) => `${record.sourceSnapshot}::${record.workflow}`),
  );
  const uncovered: UncoveredPipeline[] = [];
  for (const event of input.expected) {
    const sourceSnapshot = `${event.repository}@${event.commit}`;
    for (const pipeline of event.classification.pipelines)
      if (!covered.has(`${sourceSnapshot}::${pipeline}`))
        uncovered.push({
          pullRequest: event.pullRequest?.number ?? 0,
          url: event.pullRequest?.url ?? '',
          sourceSnapshot,
          pipeline,
        });
  }
  return uncovered;
}

export function composeReconcileMessage(
  uncovered: readonly UncoveredPipeline[],
): string {
  return [
    `🔴 Documentation freshness: ${uncovered.length} uncovered ${
      uncovered.length === 1 ? 'pipeline' : 'pipelines'
    } with no run record`,
    ...uncovered.map(
      (entry) =>
        `#${entry.pullRequest} ${entry.pipeline} — ${entry.sourceSnapshot} (${entry.url})`,
    ),
    'Replay with `bun docs:dispatch` after confirming the agent writes run records.',
  ].join('\n');
}

const DURATION_PATTERN = /^(\d+)([hd])$/;

export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match)
    throw new Error(`Duration must look like 24h or 7d, got ${value}`);
  const count = Number(match[1]);
  return count * (match[2] === 'h' ? 3_600_000 : 86_400_000);
}

// A stalled GitHub request must not hold the sweep open indefinitely.
const gh = (args: readonly string[]): string =>
  execFileSync('gh', [...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  });

const changedFilesBetween = (
  base: string,
  merge: string,
): readonly string[] => {
  const diff = execFileSync('git', ['diff', '--name-only', base, merge], {
    cwd: root,
    encoding: 'utf8',
  });
  return parseChangedFiles(diff);
};

type GhPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string } | null;
  merged_by: { login: string } | null;
  base: { ref: string; sha: string };
  head: { repo: { fork: boolean } | null };
};

// `gh api --paginate` prints one JSON array per page; `--slurp` wraps them in
// an outer array, which is flattened here.
export function pullRequestsFromSlurp(raw: string): readonly GhPullRequest[] {
  return (JSON.parse(raw) as GhPullRequest[][]).flat();
}

type PullRequestMetadata = Omit<MergedPullRequest, 'changedFiles'>;

function listMergedPullRequests(
  repository: string,
): readonly PullRequestMetadata[] {
  return pullRequestsFromSlurp(
    gh([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    ]),
  ).flatMap((pullRequest) =>
    pullRequest.merged_at && pullRequest.merge_commit_sha
      ? [
          {
            id: pullRequest.id,
            number: pullRequest.number,
            title: pullRequest.title,
            body: pullRequest.body,
            url: pullRequest.html_url,
            author: pullRequest.user?.login ?? null,
            mergedBy: pullRequest.merged_by?.login ?? null,
            repository,
            baseRef: pullRequest.base.ref,
            baseSha: pullRequest.base.sha,
            mergeCommitSha: pullRequest.merge_commit_sha,
            mergedAt: pullRequest.merged_at,
            fork: pullRequest.head.repo?.fork ?? true,
          },
        ]
      : [],
  );
}

// Diffed exactly as notify-merge.yml does (base.sha..merge_commit_sha), and
// only for merges inside the window, so an old base outside a shallow
// checkout never has to exist locally.
const withChangedFiles = (
  pullRequest: PullRequestMetadata,
): MergedPullRequest => ({
  ...pullRequest,
  changedFiles: changedFilesBetween(
    pullRequest.baseSha,
    pullRequest.mergeCommitSha,
  ),
});

type RowsPage = {
  readonly rows: readonly SheetRow[];
  readonly hasMore: boolean;
  readonly nextFromRow: number | null;
};

// PageSpace's answer is untrusted: a page with no hasMore flag would end the
// read after one page, and a cursor that does not advance would request the
// same page forever. Either reports coverage wrongly, so both throw.
function validPage(value: unknown, fromRow: number): RowsPage {
  const page = value as Partial<RowsPage> | null;
  const valid =
    typeof page === 'object' &&
    page !== null &&
    Array.isArray(page.rows) &&
    typeof page.hasMore === 'boolean' &&
    (!page.hasMore ||
      (Number.isInteger(page.nextFromRow) &&
        (page.nextFromRow as number) > fromRow));
  if (!valid)
    throw new Error(
      `Reading Documentation Runs returned an invalid page at row ${fromRow}: ${JSON.stringify(value).slice(0, 200)}`,
    );
  return page as RowsPage;
}

// Reads the Documentation Runs sheet page by page and validates every row
// against the run-record contract. A refused read throws: reconciling against
// no records would report every merge uncovered and prove nothing.
export async function readRunRecords(
  options: PagespaceApiOptions & {
    /** `pagespace.pages.docsRunsSheet` from project.config.json. */
    readonly runsSheetId: string;
    readonly fetchImpl?: typeof fetch;
    readonly timeoutMs?: number;
  },
): Promise<readonly DocumentationRunRecord[]> {
  const { apiUrl, headers } = pagespaceApi(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  // One deadline for the whole read, not one per page, so a slow multi-page
  // sheet cannot take pages × timeout.
  const end = Date.now() + timeoutMs;
  const timedOut = (fromRow: number) =>
    new Error(
      `Reading Documentation Runs did not answer within ${Math.round(timeoutMs / 1000)}s at row ${fromRow}`,
    );
  const endpoint = new URL('/api/mcp/sheets', apiUrl).toString();
  const rows: SheetRow[] = [];
  for (let fromRow: number | null = 0; fromRow !== null;) {
    if (Date.now() >= end) throw timedOut(fromRow);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers,
        signal: AbortSignal.timeout(Math.max(1, end - Date.now())),
        body: JSON.stringify({
          operation: 'get-rows',
          pageId: options.runsSheetId,
          fromRow,
          limit: 5000,
        }),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError')
        throw timedOut(fromRow);
      throw error;
    }
    const body = await response.text();
    if (!response.ok)
      throw new Error(
        `Reading Documentation Runs responded ${response.status}: ${body}`,
      );
    const page = validPage(JSON.parse(body) as unknown, fromRow);
    rows.push(...page.rows);
    fromRow = page.hasMore ? page.nextFromRow : null;
  }
  return runRecordsFromSheet(rows);
}

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

async function main(): Promise<void> {
  const config = loadProjectConfig();
  const repository = flagValue('repository') ?? config.repo;
  const sinceMs = parseDuration(flagValue('since') ?? '24h');
  const graceMs = parseDuration(flagValue('grace') ?? '1h');

  const merges = selectReconcilableMerges({
    pullRequests: listMergedPullRequests(repository),
    now: Date.now(),
    sinceMs,
    graceMs,
  }).map(withChangedFiles);
  const expected = expectedEvents(merges);
  const uncovered = findMissingRuns({
    expected,
    runRecords: await readRunRecords({
      runsSheetId: requirePage(config, 'docsRunsSheet'),
    }),
  });

  if (process.argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ merges: merges.length, expected, uncovered }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(
    uncovered.length === 0
      ? `Documentation freshness: ${expected.length} expected events, all covered\n`
      : `${composeReconcileMessage(uncovered)}\n`,
  );
}

if (import.meta.main) {
  await main();
}
