#!/usr/bin/env bun
/**
 * `bun board:stale [--apply]`: lists tasks whose status disagrees
 * with git — merged but not yet In Review, or Done without a review record —
 * and with --apply moves each to its correct pre-Done status (Merged, or In
 * Review when unmerged). It never marks anything Done and never files review
 * debt: merges before the enforcement cutoff are listed, not filed.
 */
import {
  deliveredCodes,
  isReviewPage,
  MERGED_STATUS,
  reviewedCodes,
  staleLeaves,
  taskCode,
  type BoardTask,
} from './board-state';
import { extractTaskIds } from './notify-drive';
import {
  loadProjectConfig,
  requireDriveId,
  requirePage,
} from './project-config';

type Result = { readonly code: number; readonly stdout: string };
type MergedPr = {
  readonly number: number;
  readonly mergedAt: string;
  readonly title: string;
  readonly headRefName: string;
  readonly body: string;
};

export type StaleDeps = {
  readonly pagespace: (args: readonly string[]) => Result;
  readonly gh: (args: readonly string[]) => Result;
  /** reviewEnforcementCutoff from policy/github/repository.json. */
  readonly cutoff: string | null;
  /** `pagespace.driveId` from project.config.json. */
  readonly driveId: string;
  /** `pagespace.pages.reviews` from project.config.json. */
  readonly reviewsFolderId: string;
  readonly out: (text: string) => void;
};

type TaskList = {
  readonly tasks: readonly {
    readonly id: string;
    readonly pageId: string;
    readonly title: string;
    readonly status: string;
    readonly completedAt?: string | null;
  }[];
  readonly availableStatuses: readonly { readonly slug: string }[];
};

function json<T>(deps: StaleDeps, args: readonly string[]): T {
  const result = deps.pagespace([...args, '--json']);
  if (result.code !== 0) throw new Error(`pagespace ${args.join(' ')} failed`);
  return JSON.parse(result.stdout) as T;
}

type TreePage = {
  id: string;
  type: string;
  title: string;
  hasChildren?: boolean;
};

const tree = (deps: StaleDeps, parentId?: string) =>
  json<{ pages: TreePage[] }>(deps, [
    'pages',
    'tree',
    '--drive',
    deps.driveId,
    ...(parentId ? [parentId] : []),
  ]).pages;

const pageText = (deps: StaleDeps, pageId: string): string =>
  json<{ content?: string }>(deps, ['pages', 'read', pageId]).content ?? '';

/** Codes covered by any published review page in the Reviews folder. */
function readReviewed(deps: StaleDeps): ReadonlySet<string> {
  const reviews = tree(deps, deps.reviewsFolderId)
    .filter((page) => isReviewPage(page.title))
    .map((page) => ({ ...page, content: pageText(deps, page.id) }));
  return reviewedCodes(reviews, extractTaskIds);
}

function readBoard(deps: StaleDeps) {
  const pages = tree(deps);
  const reviewed = readReviewed(deps);
  const lists = new Map<string, TaskList>();
  const tasks: BoardTask[] = [];
  for (const page of pages) {
    if (page.type !== 'TASK_LIST' || !page.hasChildren) continue;
    const list = json<TaskList>(deps, ['tasks', 'list', page.id]);
    lists.set(page.id, list);
    for (const task of list.tasks) {
      const code = taskCode(task.title);
      if (!code) continue;
      const linked =
        task.status === 'completed' &&
        !reviewed.has(code) &&
        /Review(?: record)? —/.test(pageText(deps, task.pageId));
      tasks.push({
        code,
        pageId: task.pageId,
        listId: page.id,
        taskId: task.id,
        status: task.status,
        hasReviewRecord: reviewed.has(code) || linked,
        completedAt: task.completedAt ?? undefined,
      });
    }
  }
  return { lists, tasks };
}

const MERGED_PRS = [
  'pr',
  'list',
  '--state',
  'merged',
  '--limit',
  '1000',
  '--json',
  'number,title,headRefName,body,mergedAt',
];

export function runStaleCheck(deps: StaleDeps, apply: boolean): number {
  const listed = deps.gh(MERGED_PRS);
  if (listed.code !== 0) {
    deps.out(`gh pr list failed (exit ${listed.code}); nothing was checked.\n`);
    return 1;
  }
  const merged = new Map<string, string>();
  for (const pr of JSON.parse(listed.stdout) as MergedPr[])
    for (const code of deliveredCodes(pr))
      if (!merged.has(code) || pr.mergedAt < (merged.get(code) ?? ''))
        merged.set(code, pr.mergedAt);
  const { lists, tasks } = readBoard(deps);
  const stale = staleLeaves(tasks, merged, deps.cutoff);
  for (const { task, reason, to } of stale)
    deps.out(`${task.code} ${reason} → ${to}  (${task.pageId})\n`);
  deps.out(`${stale.length} stale of ${tasks.length} tasks\n`);
  if (!apply) return 0;
  const withMerged = new Set(
    [...lists]
      .filter(([, list]) =>
        list.availableStatuses.some((s) => s.slug === MERGED_STATUS.slug),
      )
      .map(([id]) => id),
  );
  for (const { task, to } of stale) {
    if (to === MERGED_STATUS.slug && !withMerged.has(task.listId)) {
      json(deps, [
        'tasks',
        'create-status',
        task.listId,
        '--name',
        MERGED_STATUS.name,
        '--color',
        MERGED_STATUS.color,
        '--group',
        MERGED_STATUS.group,
      ]);
      withMerged.add(task.listId);
    }
    json(deps, ['tasks', 'update', task.listId, task.taskId, '--status', to]);
  }
  deps.out(`applied ${stale.length} status changes; nothing marked Done\n`);
  return 0;
}

if (import.meta.main) {
  const spawn = (command: string, args: readonly string[]): Result => {
    const result = Bun.spawnSync([command, ...args], {
      stdout: 'pipe',
      stderr: 'inherit',
    });
    return { code: result.exitCode, stdout: result.stdout.toString() };
  };
  const project = loadProjectConfig();
  process.exitCode = runStaleCheck(
    {
      driveId: requireDriveId(project),
      reviewsFolderId: requirePage(project, 'reviews'),
      // A walk of the whole drive makes hundreds of calls; retry a transient
      // network failure twice rather than abandon the run.
      pagespace: (args) => {
        let result = spawn('pagespace', args);
        for (let retry = 0; retry < 2 && result.code !== 0; retry += 1) {
          Bun.sleepSync(1000);
          result = spawn('pagespace', args);
        }
        return result;
      },
      gh: (args) => spawn('gh', args),
      cutoff: (
        (await Bun.file(
          new URL('../policy/github/repository.json', import.meta.url),
        ).json()) as { reviewEnforcementCutoff: string | null }
      ).reviewEnforcementCutoff,
      out: (text) => process.stdout.write(text),
    },
    process.argv.includes('--apply'),
  );
}
