import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  followUpMerge,
  readTaskList,
  type FollowupDeps,
  type MergedPr,
} from './merge-followup';

setupRitewayBun();

const tree = [
  {
    id: 'phase',
    type: 'TASK_LIST',
    title: 'Phase — Guardrails',
    children: [
      { id: 'leaf1', type: 'TASK_LIST', title: 'GRD-6.1 — Given a, should b' },
      { id: 'leaf2', type: 'TASK_LIST', title: 'GRD-6.2 — Given c, should d' },
    ],
  },
];

const pr: MergedPr = {
  number: 61,
  title: 'feat(guard): autonomy guardrails (GRD-6.1)',
  url: 'https://github.com/o/r/pull/61',
  body: 'Tasks: GRD-6.1',
  branch: 'pu/grd-6-autonomy',
  headSha: 'd'.repeat(40),
  mergedAt: '2026-09-25T10:00:00Z',
};

function fakes(
  options: {
    statuses?: string[];
    reviewState?: string;
    cutoff?: string | null;
    issues?: string[];
    issuePage?: string;
  } = {},
) {
  const log: string[] = [];
  const tasks: Record<string, { id: string; pageId: string; status: string }> =
    {
      leaf1: { id: 't1', pageId: 'leaf1', status: 'in_review' },
      leaf2: { id: 't2', pageId: 'leaf2', status: 'pending' },
    };
  const deps: FollowupDeps = {
    cutoff:
      options.cutoff === undefined ? '2026-09-24T00:00:00Z' : options.cutoff,
    drivePages: async () => tree,
    listTasks: async () => ({
      tasks: Object.values(tasks),
      availableStatuses: (options.statuses ?? ['in_review', 'completed']).map(
        (slug) => ({ slug }),
      ),
    }),
    createStatus: async (listId) => void log.push(`create-status ${listId}`),
    updateStatus: async (listId, taskId, status) =>
      void log.push(`status ${listId} ${taskId} ${status}`),
    issueTitles: async () => options.issues ?? ['ISSUE-14 — x'],
    createIssue: async (title, _criteria, related) => {
      log.push(`issue ${title}`);
      log.push(
        `related ${related.map((ref) => `${ref.label}=${ref.id}`).join(' ')}`,
      );
      return options.issuePage ?? 'issuepage';
    },
    reviewState: async () => options.reviewState,
    notify: async (message) => void log.push(`sprint-room ${message}`),
  };
  return { deps, log };
}

describe('merge follow-up', () => {
  test('moves every task the PR names to Merged, creating the status once', async () => {
    const { deps, log } = fakes({ reviewState: 'success' });
    await followUpMerge(deps, pr);
    assert({
      given:
        'a reviewed merge naming GRD-6.1 on a list without a Merged status',
      should: 'create the status and move only GRD-6.1',
      actual: log,
      expected: ['create-status phase', 'status phase t1 merged'],
    });
  });

  test('records review debt for an unreviewed merge after the cutoff', async () => {
    const { deps, log } = fakes({ statuses: ['merged'] });
    const result = await followUpMerge(deps, pr);
    assert({
      given: 'a merge after the cutoff with no review-record status',
      should: 'file ISSUE-15 and post the Sprint Room notice',
      actual: [
        log.filter((line) => line.startsWith('issue')),
        log.some(
          (line) => line.startsWith('sprint-room') && line.includes('ISSUE-15'),
        ),
        result.debt,
      ],
      expected: [
        [
          'issue ISSUE-15 — Given PR #61 merged without a review record, should get a post-merge independent review of dddddddddddd',
        ],
        true,
        'ISSUE-15',
      ],
    });
  });

  test('files nothing before the cutoff or when the debt already exists', async () => {
    const early = fakes({
      statuses: ['merged'],
      cutoff: '2026-09-26T00:00:00Z',
    });
    const unset = fakes({ statuses: ['merged'], cutoff: null });
    const again = fakes({
      statuses: ['merged'],
      issues: [
        'ISSUE-15 — Given PR #61 merged without a review record, should get a post-merge independent review of dddddddddddd',
      ],
    });
    await followUpMerge(early.deps, pr);
    await followUpMerge(unset.deps, pr);
    await followUpMerge(again.deps, pr);
    assert({
      given: 'a pre-cutoff merge, no cutoff yet, and a re-run after filing',
      should: 'file no issue in any case',
      actual: [early.log, unset.log, again.log].map((log) =>
        log.some((line) => line.startsWith('issue')),
      ),
      expected: [false, false, false],
    });
  });

  test('creates the Merged status once for several tasks in one list', async () => {
    const { deps, log } = fakes({ reviewState: 'success' });
    await followUpMerge(deps, { ...pr, body: 'Tasks: GRD-6.1 · GRD-6.2' });
    assert({
      given: 'a merge naming two tasks of a list without a Merged status',
      should: 'create the status once and move both tasks',
      actual: log,
      expected: [
        'create-status phase',
        'status phase t1 merged',
        'status phase t2 merged',
      ],
    });
  });

  test('links the debt issue to the tasks the PR delivered', async () => {
    const { deps, log } = fakes({ statuses: ['merged'] });
    await followUpMerge(deps, pr);
    assert({
      given: 'review debt for a merge delivering GRD-6.1',
      should: 'relate the new issue to the GRD-6.1 task page',
      actual: log.find((line) => line.startsWith('related')),
      expected: 'related Task=leaf1',
    });
  });

  test('fails loudly on an issue without a page or a merge without a time', async () => {
    const noPage = fakes({ statuses: ['merged'], issuePage: '' });
    const noTime = fakes({ statuses: ['merged'] });
    assert({
      given:
        'PageSpace returning no page for the issue, and an empty merged-at',
      should: 'reject each instead of carrying on without debt',
      actual: [
        await followUpMerge(noPage.deps, pr).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
        await followUpMerge(noTime.deps, { ...pr, mergedAt: '' }).then(
          () => 'resolved',
          (error: Error) => error.message,
        ),
      ],
      expected: [
        'PageSpace created ISSUE-15 without returning its page',
        'PR #61 has no valid merged-at time: ""',
      ],
    });
  });
});

describe('reading the live PageSpace tasks API', () => {
  test('takes statuses from statusConfigs and tasks from every page', async () => {
    // The shape GET /api/pages/:id/tasks returns: statusConfigs, not
    // availableStatuses, and at most `limit` tasks with hasMore.
    const pages = [
      {
        tasks: [{ id: 't1', pageId: 'p1', status: 'in_review', title: 'A' }],
        statusConfigs: [
          { slug: 'in_review', name: 'In Review', group: 'in_progress' },
          { slug: 'completed', name: 'Done', group: 'done' },
        ],
        hasMore: true,
      },
      {
        tasks: [{ id: 't2', pageId: 'p2', status: 'pending', title: 'B' }],
        statusConfigs: [],
        hasMore: false,
      },
    ];
    const offsets: number[] = [];
    const list = await readTaskList(async (offset) => {
      offsets.push(offset);
      return pages[offsets.length - 1];
    });
    assert({
      given: 'two pages of one task each and the list statuses on the first',
      should:
        'return both tasks and the list statuses, fetching offsets 0 and 1',
      actual: [
        list.tasks.map((task) => task.id),
        list.availableStatuses.map((status) => status.slug),
        offsets,
      ],
      expected: [
        ['t1', 't2'],
        ['in_review', 'completed'],
        [0, 1],
      ],
    });
  });

  test('advances by the rows received when the server caps below the request', async () => {
    // The follow-up asks for 200 per page; a deployed server caps at 2.
    const rows = ['t1', 't2', 't3', 't4', 't5'];
    const offsets: number[] = [];
    const list = await readTaskList(async (offset) => {
      offsets.push(offset);
      const slice = rows.slice(offset, offset + 2);
      return {
        tasks: slice.map((id) => ({ id, pageId: id, status: 'pending' })),
        statusConfigs: [],
        hasMore: offset + 2 < rows.length,
      };
    });
    assert({
      given: 'five tasks served two at a time although 200 were requested',
      should: 'fetch offsets 0, 2 and 4 and skip no task',
      actual: [offsets, list.tasks.map((task) => task.id)],
      expected: [[0, 2, 4], rows],
    });
  });
});
