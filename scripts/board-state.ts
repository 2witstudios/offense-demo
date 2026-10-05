/**
 * Pure rules that keep the board following git: which task pages
 * a PR names, the status a merge moves them to, when a merge after the
 * enforcement cutoff leaves review debt, and which tasks drifted from git.
 * The merge workflow (merge-followup.ts) and `bun board:stale` share them.
 */
import { extractTaskIds, TASK_CODE } from './notify-drive';

/** The status a merged task waits in until an independent review grants Done. */
export const MERGED_STATUS = {
  slug: 'merged',
  name: 'Merged',
  color: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  group: 'in_progress',
} as const;

const TASK_TITLE = new RegExp(String.raw`^(${TASK_CODE})\s+—`);

/** The task code a leaf title starts with, e.g. `RT-2.2f — Given …`. */
export const taskCode = (title: string): string | undefined =>
  TASK_TITLE.exec(title)?.[1];

type PageNode = {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly children?: readonly PageNode[];
};

export type TaskPage = {
  readonly code: string;
  readonly pageId: string;
  readonly listId: string;
};

/** Task pages in a drive tree, keyed by the code their title starts with. */
export function findTaskPages(
  nodes: readonly PageNode[],
  parentId?: string,
): readonly TaskPage[] {
  return nodes.flatMap((node) => {
    const code = taskCode(node.title);
    const own =
      code && node.type === 'TASK_LIST' && parentId
        ? [{ code, pageId: node.id, listId: parentId }]
        : [];
    return [...own, ...findTaskPages(node.children ?? [], node.id)];
  });
}

const TASKS_LINE = /^\s*[-*]?\s*Tasks?\s*:/;

/**
 * The task codes a PR delivers: those in its title, its branch and its
 * body's `Tasks:` line. A code the body only mentions (a later leaf, an ADR
 * citation, a related issue) is not delivered by the PR, and an ISSUE-n
 * closes only through a PR whose title or branch names it: a Tasks line
 * that links an issue (the one a PR filed, say) does not close it.
 */
export function deliveredCodes(
  pr: {
    readonly title: string;
    readonly headRefName: string;
    readonly body: string | null;
  },
  extract: (text: string) => readonly string[] = extractTaskIds,
): readonly string[] {
  const named = extract([pr.title, pr.headRefName].join('\n'));
  const listed = extract(
    (pr.body ?? '')
      .split('\n')
      .filter((line) => TASKS_LINE.test(line))
      .join('\n'),
  ).filter((code) => !code.startsWith('ISSUE-'));
  return [...new Set([...named, ...listed])];
}

/** Where a merge moves a task; undefined when it stays. */
export function mergedTarget(status: string): string | undefined {
  return status === MERGED_STATUS.slug || status === 'completed'
    ? undefined
    : MERGED_STATUS.slug;
}

export function needsDebt(input: {
  readonly mergedAt: string;
  readonly cutoff: string | null;
  readonly reviewState: string | undefined;
}): boolean {
  return (
    input.cutoff !== null &&
    Date.parse(input.mergedAt) >= Date.parse(input.cutoff) &&
    input.reviewState !== 'success'
  );
}

export function debtIssue(input: {
  readonly pr: number;
  readonly title: string;
  readonly url: string;
  readonly headSha: string;
  readonly codes: readonly string[];
}): { readonly title: string; readonly criteria: readonly string[] } {
  const sha = input.headSha.slice(0, 12);
  const tasks = input.codes.length > 0 ? input.codes.join(', ') : 'no task';
  return {
    title: `Given PR #${input.pr} merged without a review record, should get a post-merge independent review of ${sha}`,
    criteria: [
      `Given PR #${input.pr} (${input.title}, ${input.url}) merged at head ${input.headSha} with no review-record status, should get an independent review record for ${sha} under Reviews/<Epic>, linked from ${tasks}.`,
      `Given that record's findings, should fix or file each one; the tasks stay Merged until the record grants Done.`,
    ],
  };
}

const REVIEW_TITLE = /^Review(?: record)? —/;

export const isReviewPage = (title: string): boolean =>
  REVIEW_TITLE.test(title);

/**
 * Task codes an existing review covers: named in a review page's title or
 * body (stage reviews list several), or linked from the task page itself.
 */
export function reviewedCodes(
  reviews: readonly {
    readonly id: string;
    readonly title: string;
    readonly content: string;
  }[],
  extractCodes: (text: string) => readonly string[],
): ReadonlySet<string> {
  return new Set(
    reviews.flatMap((review) =>
      extractCodes(`${review.title}\n${review.content}`),
    ),
  );
}

export type BoardTask = TaskPage & {
  readonly taskId: string;
  readonly status: string;
  readonly hasReviewRecord: boolean;
  /** When the task was marked Done, if the board recorded it. */
  readonly completedAt?: string;
};

// Statuses before In Review: a merged task in one of them has drifted.
const BEFORE_REVIEW = new Set(['pending', 'ready', 'in_progress', 'blocked']);

/**
 * Done without a review record is drift only after the enforcement cutoff:
 * reviews before it often happened without being stored (owner decision,
 * 2026-09-22). With no cutoff set, everything so far is before it.
 */
function afterCutoff(at: string | undefined, cutoff: string | null) {
  return (
    cutoff !== null && at !== undefined && Date.parse(at) >= Date.parse(cutoff)
  );
}

/** Tasks whose status disagrees with git, with the pre-Done status to fix to. */
export function staleLeaves(
  tasks: readonly BoardTask[],
  mergedAt: ReadonlyMap<string, string>,
  cutoff: string | null,
): readonly {
  readonly task: BoardTask;
  readonly reason: string;
  readonly to: string;
}[] {
  return tasks.flatMap((task) => {
    const merged = mergedAt.get(task.code);
    if (merged !== undefined && BEFORE_REVIEW.has(task.status))
      return [
        { task, reason: `merged but ${task.status}`, to: MERGED_STATUS.slug },
      ];
    const unreviewedDone =
      task.status === 'completed' &&
      !task.hasReviewRecord &&
      afterCutoff(task.completedAt ?? merged, cutoff);
    return unreviewedDone
      ? [
          {
            task,
            reason: 'Done without a review record',
            to: merged !== undefined ? MERGED_STATUS.slug : 'in_review',
          },
        ]
      : [];
  });
}
