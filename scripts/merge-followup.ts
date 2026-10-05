#!/usr/bin/env bun
/**
 * Runs after every merge to main (.github/workflows/notify-merge.yml). It
 * moves each task the PR names to Merged, where the task waits
 * for an independent review to grant Done. After the enforcement cutoff
 * (policy/github/repository.json), a merge whose head SHA has no successful
 * review-record status also leaves post-merge review debt: an ISSUE-n in the
 * drive's Issues list and a Sprint Room notice. Merges before the cutoff
 * file nothing.
 */
import {
  issueListIds,
  leafBody,
  nextCodeNumber,
  type RelatedEntry,
} from './board-model';
import {
  debtIssue,
  deliveredCodes,
  findTaskPages,
  MERGED_STATUS,
  mergedTarget,
  needsDebt,
} from './board-state';
import { postToDrive } from './notify-drive';
import { pagespaceApi } from './pagespace-docs';
import {
  driveProvisioned,
  driveSkipNotice,
  loadProjectConfig,
  requireDriveId,
  requirePage,
  type ProjectConfig,
} from './project-config';

export type MergedPr = {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly branch: string;
  readonly headSha: string;
  readonly mergedAt: string;
};

type PageNode = Parameters<typeof findTaskPages>[0][number];
type TaskList = {
  readonly tasks: readonly {
    readonly id: string;
    readonly pageId: string;
    readonly status: string;
  }[];
  readonly availableStatuses: readonly { readonly slug: string }[];
};

/** One page of GET /api/pages/:id/tasks, as the PageSpace server returns it. */
type TasksPage = {
  readonly tasks: readonly {
    readonly id: string;
    readonly pageId: string;
    readonly status: string;
    readonly title?: string;
  }[];
  readonly statusConfigs?: readonly { readonly slug: string }[];
  readonly hasMore?: boolean;
};

const TASKS_PAGE_SIZE = 200;

/**
 * A whole task list from the REST API: statuses come from statusConfigs
 * (the CLI calls them availableStatuses), and tasks from every page, since
 * the server returns at most `limit` per request and reports hasMore.
 */
export async function readTaskList(
  fetchPage: (offset: number) => Promise<TasksPage>,
): Promise<TaskList & { readonly titles: readonly string[] }> {
  const tasks: TasksPage['tasks'][number][] = [];
  let statuses: readonly { readonly slug: string }[] = [];
  // Advance by the rows received: a server may cap a page below the limit.
  for (let offset = 0; ;) {
    const page = await fetchPage(offset);
    if (offset === 0) statuses = page.statusConfigs ?? [];
    tasks.push(...page.tasks);
    if (!page.hasMore || page.tasks.length === 0) break;
    offset += page.tasks.length;
  }
  return {
    tasks,
    availableStatuses: statuses.map(({ slug }) => ({ slug })),
    titles: tasks.map((task) => task.title ?? ''),
  };
}

const tasksOf = (listId: string) =>
  readTaskList((offset) =>
    pagespace<TasksPage>(
      `/api/pages/${listId}/tasks?limit=${TASKS_PAGE_SIZE}&offset=${offset}`,
    ),
  );

export type FollowupDeps = {
  readonly cutoff: string | null;
  readonly drivePages: () => Promise<readonly PageNode[]>;
  readonly listTasks: (listId: string) => Promise<TaskList>;
  readonly createStatus: (listId: string) => Promise<void>;
  readonly updateStatus: (
    listId: string,
    taskId: string,
    status: string,
  ) => Promise<void>;
  readonly issueTitles: () => Promise<readonly string[]>;
  readonly createIssue: (
    title: string,
    criteria: readonly string[],
    related: readonly RelatedEntry[],
  ) => Promise<string>;
  readonly reviewState: (sha: string) => Promise<string | undefined>;
  readonly notify: (message: string) => Promise<void>;
};

async function moveTasks(
  deps: FollowupDeps,
  pages: ReturnType<typeof findTaskPages>,
) {
  const moved: string[] = [];
  for (const listId of new Set(pages.map((page) => page.listId))) {
    const list = await deps.listTasks(listId);
    let hasStatus = list.availableStatuses.some(
      (status) => status.slug === MERGED_STATUS.slug,
    );
    for (const page of pages.filter((p) => p.listId === listId)) {
      const task = list.tasks.find((t) => t.pageId === page.pageId);
      const target = task && mergedTarget(task.status);
      if (!task || !target) continue;
      if (!hasStatus) await deps.createStatus(listId);
      hasStatus = true;
      await deps.updateStatus(listId, task.id, target);
      moved.push(page.code);
    }
  }
  return moved;
}

async function recordDebt(
  deps: FollowupDeps,
  pr: MergedPr,
  codes: readonly string[],
  tasks: readonly RelatedEntry[],
): Promise<string | undefined> {
  const reviewState = await deps.reviewState(pr.headSha);
  if (!needsDebt({ mergedAt: pr.mergedAt, cutoff: deps.cutoff, reviewState }))
    return undefined;
  const issue = debtIssue({ ...pr, pr: pr.number, codes });
  const titles = await deps.issueTitles();
  const existing = titles.find((title) => title.endsWith(issue.title));
  const code =
    existing?.split(' ')[0] ?? `ISSUE-${nextCodeNumber(titles, 'ISSUE')}`;
  if (existing) return code;
  const pageId = await deps.createIssue(
    `${code} — ${issue.title}`,
    issue.criteria,
    tasks,
  );
  if (!pageId)
    throw new Error(`PageSpace created ${code} without returning its page`);
  await deps.notify(
    `⚠️ Post-merge review debt: #${pr.number} merged without a review-record status for ${pr.headSha.slice(0, 12)} → ${code}\n${pr.url}`,
  );
  return code;
}

export async function followUpMerge(
  deps: FollowupDeps,
  pr: MergedPr,
): Promise<{ readonly moved: readonly string[]; readonly debt?: string }> {
  // An unparseable time would compare as NaN and silently file no debt.
  if (Number.isNaN(Date.parse(pr.mergedAt)))
    throw new Error(
      `PR #${pr.number} has no valid merged-at time: ${JSON.stringify(pr.mergedAt)}`,
    );
  const codes = deliveredCodes({
    title: pr.title,
    headRefName: pr.branch,
    body: pr.body,
  });
  const pages = findTaskPages(await deps.drivePages()).filter((page) =>
    codes.includes(page.code),
  );
  const moved = await moveTasks(deps, pages);
  // The issue's Related pages link the tasks the unreviewed merge delivered.
  const tasks = pages.map((page) => ({
    label: 'Task',
    id: page.pageId,
    title: page.code,
  }));
  return { moved, debt: await recordDebt(deps, pr, codes, tasks) };
}

// ------------------------------------------------------------------- edges

async function pagespace<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl, headers } = pagespaceApi();
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers,
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `PageSpace ${init?.method ?? 'GET'} ${path} ${response.status}`,
    );
  return (await response.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

function liveDeps(
  repository: string,
  cutoff: string | null,
  project: ProjectConfig,
): FollowupDeps {
  return {
    cutoff,
    drivePages: () =>
      pagespace<readonly PageNode[]>(
        `/api/drives/${requireDriveId(project)}/pages`,
      ),
    listTasks: tasksOf,
    createStatus: async (listId) => {
      await pagespace(
        `/api/pages/${listId}/tasks/statuses`,
        json('POST', {
          name: MERGED_STATUS.name,
          color: MERGED_STATUS.color,
          group: MERGED_STATUS.group,
        }),
      );
    },
    updateStatus: async (listId, taskId, status) => {
      await pagespace(
        `/api/pages/${listId}/tasks/${taskId}`,
        json('PATCH', { status }),
      );
    },
    issueTitles: async () => {
      const lists = await Promise.all(issueListIds(project).map(tasksOf));
      return lists.flatMap((list) => list.titles);
    },
    createIssue: async (title, criteria, related) => {
      const task = await pagespace<{ pageId?: string; page?: { id: string } }>(
        `/api/pages/${requirePage(project, 'issues')}/tasks`,
        json('POST', { title }),
      );
      const pageId = task.pageId ?? task.page?.id ?? '';
      if (!pageId) return '';
      await pagespace(
        '/api/mcp/documents',
        json('POST', {
          operation: 'replace',
          pageId,
          startLine: 1,
          content: leafBody({ criteria, related }),
        }),
      );
      return pageId;
    },
    reviewState: async (sha) => {
      const result = Bun.spawnSync(
        [
          'gh',
          'api',
          `repos/${repository}/commits/${sha}/statuses`,
          '--jq',
          '[.[] | select(.context == "review-record")][0].state',
        ],
        { stdout: 'pipe', stderr: 'inherit' },
      );
      const state = result.stdout.toString().trim();
      return result.exitCode === 0 && state !== '' && state !== 'null'
        ? state
        : undefined;
    },
    notify: (message) => postToDrive('sprint-room', message),
  };
}

if (import.meta.main && !driveProvisioned(loadProjectConfig())) {
  console.log(driveSkipNotice('merge follow-up'));
} else if (import.meta.main) {
  const env = process.env;
  const config = (await Bun.file(
    new URL('../policy/github/repository.json', import.meta.url),
  ).json()) as { reviewEnforcementCutoff: string | null };
  const pr: MergedPr = {
    number: Number(env.MERGE_PR),
    title: env.MERGE_TITLE ?? '',
    url: env.MERGE_URL ?? '',
    body: env.MERGE_BODY ?? '',
    branch: env.MERGE_BRANCH ?? '',
    headSha: env.MERGE_HEAD_SHA ?? '',
    mergedAt: env.MERGE_MERGED_AT ?? '',
  };
  if (!Number.isInteger(pr.number) || !/^[0-9a-f]{40}$/.test(pr.headSha)) {
    process.stderr.write(
      'merge-followup: MERGE_PR and MERGE_HEAD_SHA are required\n',
    );
    process.exit(2);
  }
  const result = await followUpMerge(
    liveDeps(
      env.GITHUB_REPOSITORY ?? '',
      config.reviewEnforcementCutoff,
      loadProjectConfig(),
    ),
    pr,
  );
  process.stdout.write(
    `merge follow-up #${pr.number}: moved ${result.moved.join(', ') || 'no task'}; debt ${result.debt ?? 'none'}\n`,
  );
}
