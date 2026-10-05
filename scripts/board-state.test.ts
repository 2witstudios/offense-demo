import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  debtIssue,
  deliveredCodes,
  findTaskPages,
  mergedTarget,
  needsDebt,
  reviewedCodes,
  staleLeaves,
  type BoardTask,
} from './board-state';

setupRitewayBun();

const tree = [
  {
    id: 'tasks',
    type: 'TASK_LIST',
    title: 'Tasks',
    children: [
      {
        id: 'phase',
        type: 'TASK_LIST',
        title: 'Phase — Realtime',
        children: [
          { id: 'p1', type: 'TASK_LIST', title: 'RT-2.2 — Given x, should y' },
          { id: 'p2', type: 'TASK_LIST', title: 'RT-2.2f — Given a, should b' },
          { id: 'p3', type: 'DOCUMENT', title: 'RT-2.2 — notes' },
          {
            id: 'p4',
            type: 'TASK_LIST',
            title: 'RT-2.2f-r1 — Given c, should d',
          },
          {
            id: 'p5',
            type: 'TASK_LIST',
            title: 'AUTH-2.2.1 — Given e, should f',
          },
        ],
      },
    ],
  },
];

describe('findTaskPages', () => {
  test('maps task codes to task pages and their lists', () => {
    assert({
      given:
        'a drive tree with a leaf, its suffixed follow-up, a revision, a sub-leaf and a document',
      should:
        'return task-list pages keyed by the whole code their title starts with',
      actual: findTaskPages(tree),
      expected: [
        { code: 'RT-2.2', pageId: 'p1', listId: 'phase' },
        { code: 'RT-2.2f', pageId: 'p2', listId: 'phase' },
        { code: 'RT-2.2f-r1', pageId: 'p4', listId: 'phase' },
        { code: 'AUTH-2.2.1', pageId: 'p5', listId: 'phase' },
      ],
    });
  });
});

describe('mergedTarget', () => {
  test('moves open tasks to merged and never regresses Done', () => {
    assert({
      given: 'each status a merged task can be in',
      should: 'target merged unless already merged or Done',
      actual: [
        'pending',
        'ready',
        'in_progress',
        'blocked',
        'in_review',
        'merged',
        'completed',
      ].map(mergedTarget),
      expected: [
        'merged',
        'merged',
        'merged',
        'merged',
        'merged',
        undefined,
        undefined,
      ],
    });
  });
});

describe('needsDebt', () => {
  const cutoff = '2026-09-23T00:00:00Z';

  test('records debt only after the cutoff and without a review-record status', () => {
    assert({
      given: 'merges before and after the cutoff, with and without the status',
      should: 'need debt only for an unreviewed merge after the cutoff',
      actual: [
        needsDebt({
          mergedAt: '2026-09-24T00:00:00Z',
          cutoff,
          reviewState: undefined,
        }),
        needsDebt({
          mergedAt: '2026-09-24T00:00:00Z',
          cutoff,
          reviewState: 'failure',
        }),
        needsDebt({
          mergedAt: '2026-09-24T00:00:00Z',
          cutoff,
          reviewState: 'success',
        }),
        needsDebt({
          mergedAt: '2026-09-22T00:00:00Z',
          cutoff,
          reviewState: undefined,
        }),
        needsDebt({
          mergedAt: '2026-09-24T00:00:00Z',
          cutoff: null,
          reviewState: undefined,
        }),
      ],
      expected: [true, true, false, false, false],
    });
  });
});

describe('debtIssue', () => {
  test('writes an ISSUE-n body with origin, why and criteria', () => {
    const issue = debtIssue({
      pr: 61,
      title: 'feat(x): y (RT-4.1)',
      url: 'https://github.com/o/r/pull/61',
      headSha: 'c'.repeat(40),
      codes: ['RT-4.1'],
    });
    assert({
      given: 'a merged PR with no review-record status',
      should: 'name the PR, SHA and tasks and ask for a post-merge review',
      actual: [
        issue.title,
        issue.criteria.length,
        issue.criteria[0]?.includes('cccccccccccc'),
      ],
      expected: [
        'Given PR #61 merged without a review record, should get a post-merge independent review of cccccccccccc',
        2,
        true,
      ],
    });
  });
});

describe('staleLeaves', () => {
  const cutoff = '2026-09-24T00:00:00Z';
  const before = '2026-09-20T00:00:00Z';
  const after = '2026-09-25T00:00:00Z';
  const task = (overrides: Partial<BoardTask>): BoardTask => ({
    code: 'RT-1.1',
    pageId: 'p',
    listId: 'l',
    taskId: 't',
    status: 'in_progress',
    hasReviewRecord: false,
    completedAt: undefined,
    ...overrides,
  });
  const summary = (list: ReturnType<typeof staleLeaves>) =>
    list.map(({ task: { code }, reason, to }) => ({ code, reason, to }));

  test('moves merged tasks that never reached In Review to Merged', () => {
    const merged = new Map([
      ['RT-1.1', before],
      ['RT-1.2', before],
    ]);
    assert({
      given: 'a merged task still in progress, and one already in review',
      should: 'flag only the one before In Review',
      actual: summary(
        staleLeaves(
          [
            task({ code: 'RT-1.1', status: 'in_progress' }),
            task({ code: 'RT-1.2', status: 'in_review' }),
            task({ code: 'RT-1.7', status: 'ready' }),
          ],
          merged,
          cutoff,
        ),
      ),
      expected: [
        { code: 'RT-1.1', reason: 'merged but in_progress', to: 'merged' },
      ],
    });
  });

  test('accepts Done without a record before the enforcement cutoff', () => {
    assert({
      given:
        'Done tasks without records completed or merged before the cutoff, and no cutoff set yet',
      should: 'flag none of them',
      actual: [
        staleLeaves(
          [
            task({ code: 'RT-1.4', status: 'completed', completedAt: before }),
            task({ code: 'RT-1.5', status: 'completed' }),
          ],
          new Map([['RT-1.5', before]]),
          cutoff,
        ).length,
        staleLeaves(
          [task({ code: 'RT-1.4', status: 'completed', completedAt: after })],
          new Map(),
          null,
        ).length,
      ],
      expected: [0, 0],
    });
  });

  test('flags Done without a record after the enforcement cutoff', () => {
    assert({
      given:
        'Done tasks without records after the cutoff, merged and unmerged, and one with a record',
      should: 'flag the two without records with their pre-Done status',
      actual: summary(
        staleLeaves(
          [
            task({ code: 'RT-1.4', status: 'completed', completedAt: after }),
            task({ code: 'RT-1.5', status: 'completed', completedAt: after }),
            task({
              code: 'RT-1.6',
              status: 'completed',
              completedAt: after,
              hasReviewRecord: true,
            }),
          ],
          new Map([['RT-1.4', after]]),
          cutoff,
        ),
      ),
      expected: [
        {
          code: 'RT-1.4',
          reason: 'Done without a review record',
          to: 'merged',
        },
        {
          code: 'RT-1.5',
          reason: 'Done without a review record',
          to: 'in_review',
        },
      ],
    });
  });
});

describe('reviewedCodes', () => {
  test('counts every code a review page names in its title or body', () => {
    assert({
      given: 'a stage review naming three codes and a single-leaf review',
      should: 'cover all four codes',
      actual: [
        ...reviewedCodes(
          [
            {
              id: 'r1',
              title: 'Review record — stage 1 (AUTH-1.1, AUTH-1.2)',
              content: '<p>Also covers AUTH-1.4.</p>',
            },
            { id: 'r2', title: 'Review — DOCS-4 cleanup', content: '' },
          ],
          (text) => text.match(/\b[A-Z]{2,6}-\d+(?:\.\d+)?\b/g) ?? [],
        ),
      ],
      expected: ['AUTH-1.1', 'AUTH-1.2', 'AUTH-1.4', 'DOCS-4'],
    });
  });
});

describe('deliveredCodes', () => {
  test('reads delivered tasks from the title, branch and Tasks line only', () => {
    assert({
      given:
        'a PR whose body also mentions future leaves outside its Tasks line',
      should: 'return only the codes it declares it delivers',
      actual: deliveredCodes({
        title: 'feat(rt): presence leases (RT-3.1)',
        headRefName: 'pu/rt-3-1',
        body: [
          'Implements the lease model; RT-4.1 and RT-4.2 build on it later.',
          '- Tasks: [RT-3.1](url) · [RT-3.1b](url)',
          'See ADR 0033 and ISSUE-4.',
        ].join('\n'),
      }),
      expected: ['RT-3.1', 'RT-3.1b'],
    });
  });

  test('closes an issue only from the title or branch, never from a Tasks link', () => {
    const body = '- Tasks: [Issues list](url) · [ISSUE-1](url)';
    assert({
      given:
        'a PR whose Tasks line only links ISSUE-1, and one whose title names ISSUE-3',
      should: 'deliver no issue for the first and ISSUE-3 for the second',
      actual: [
        deliveredCodes({
          title: 'docs(agents): route findings to Issues',
          headRefName: 'docs/issues-list',
          body,
        }),
        deliveredCodes({
          title: 'fix(ci): pin the sprint-room actions (ISSUE-3)',
          headRefName: 'pu/issue-3',
          body: '- Tasks: [ISSUE-3](url)',
        }),
      ],
      expected: [[], ['ISSUE-3']],
    });
  });
});
