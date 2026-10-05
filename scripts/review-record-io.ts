/**
 * The shared low-level I/O for the review-record
 * check: reading a linked record page from PageSpace, and a PR's live head
 * SHA, body and comments through gh. review-record.ts's pure
 * verifier and its self-check command (`bun review:check`, ISSUE-122) both
 * read through this module, so there is exactly one copy of each call.
 */
import { pagespaceApi } from './pagespace-docs';

export type RecordPage = {
  readonly id: string;
  readonly title: string;
  readonly content: string;
};
export type PullRequest = {
  readonly number: number;
  readonly headSha: string;
  readonly body: string;
};

type FetchedPage = {
  readonly title?: string;
  readonly content?: string;
  readonly driveId?: string;
};

/**
 * A fetched page as a record, or undefined when it lives outside the
 * project's drive (`pagespace.driveId` in project.config.json): a
 * project-drive link naming another drive's page is not trusted.
 */
export const recordFromPage = (
  id: string,
  page: FetchedPage,
  driveId: string,
): RecordPage | undefined =>
  page.driveId === driveId
    ? { id, title: page.title ?? '', content: page.content ?? '' }
    : undefined;

/** Every comment body across the pages gh api --paginate --slurp returns. */
export const commentBodies = (
  pages: readonly (readonly { readonly body: string }[])[],
): string[] => pages.flat().map((comment) => comment.body);

export type Run = (args: readonly string[]) => { code: number; stdout: string };

export const gh: Run = (args) => {
  const result = Bun.spawnSync(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  return { code: result.exitCode, stdout: result.stdout.toString() };
};

export function ghJson<T>(args: readonly string[]): T {
  const result = gh(args);
  if (result.code !== 0) throw new Error(`gh ${args[1]} failed`);
  return JSON.parse(result.stdout) as T;
}

/** The PR's live head SHA, body and every issue-comment body, through gh. */
export function fetchPullRequest(
  repository: string,
  prNumber: number,
): { readonly pr: PullRequest; readonly comments: readonly string[] } {
  const pull = ghJson<{ head: { sha: string }; body: string | null }>([
    'api',
    `repos/${repository}/pulls/${prNumber}`,
  ]);
  // --slurp wraps every page in one array; without it, more than one page
  // of comments prints several arrays and cannot be parsed.
  const comments = commentBodies(
    ghJson<{ body: string }[][]>([
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/issues/${prNumber}/comments`,
    ]),
  );
  return {
    pr: { number: prNumber, headSha: pull.head.sha, body: pull.body ?? '' },
    comments,
  };
}

/** A linked page, or undefined when it cannot be read or is off-drive. */
async function readRecord(
  id: string,
  driveId: string,
): Promise<RecordPage | undefined> {
  const { apiUrl, headers } = pagespaceApi();
  try {
    const response = await fetch(new URL(`/api/pages/${id}`, apiUrl), {
      headers,
      redirect: 'error',
    });
    if (!response.ok) return undefined;
    return recordFromPage(id, (await response.json()) as FetchedPage, driveId);
  } catch {
    return undefined;
  }
}

/** Every id's record, and which ids could not be read at all. */
export async function readRecords(
  ids: readonly string[],
  driveId: string,
): Promise<{
  readonly records: readonly RecordPage[];
  readonly unreadable: readonly string[];
}> {
  const read = await Promise.all(ids.map((id) => readRecord(id, driveId)));
  return {
    records: read.filter(
      (record): record is RecordPage => record !== undefined,
    ),
    unreadable: ids.filter((_, index) => read[index] === undefined),
  };
}
