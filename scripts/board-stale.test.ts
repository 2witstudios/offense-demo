import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { runStaleCheck, type StaleDeps } from './board-stale';

setupRitewayBun();

const lists: Record<string, object> = {
  phase1: {
    tasks: [
      {
        id: 't1',
        pageId: 'p1',
        title: 'RT-1.1 — Given a, should b',
        status: 'in_progress',
      },
      {
        id: 't2',
        pageId: 'p2',
        title: 'RT-1.2 — Given c, should d',
        status: 'completed',
        completedAt: '2026-09-25T00:00:00Z',
      },
      {
        id: 't3',
        pageId: 'p3',
        title: 'RT-1.3 — Given e, should f',
        status: 'completed',
      },
    ],
    availableStatuses: [{ slug: 'in_progress' }, { slug: 'completed' }],
  },
};

function fakes(gh?: StaleDeps['gh']) {
  const calls: string[][] = [];
  const output: string[] = [];
  const deps: StaleDeps = {
    pagespace: (args) => {
      calls.push([...args]);
      if (args[0] === 'pages' && args[1] === 'tree')
        return {
          code: 0,
          stdout: JSON.stringify({
            pages: [
              {
                id: 'phase1',
                type: 'TASK_LIST',
                title: 'Phase',
                hasChildren: true,
              },
              {
                id: 'p1',
                type: 'TASK_LIST',
                title: 'RT-1.1 — x',
                hasChildren: false,
              },
            ],
          }),
        };
      if (args[0] === 'tasks' && args[1] === 'list')
        return {
          code: 0,
          stdout: JSON.stringify(
            lists[args[2]] ?? { tasks: [], availableStatuses: [] },
          ),
        };
      if (args[0] === 'pages' && args[1] === 'read')
        return {
          code: 0,
          stdout: JSON.stringify({
            content:
              args[2] === 'p3'
                ? 'Review: <a>@Review record — RT-1.3 (x)</a>'
                : '<p>none</p>',
          }),
        };
      return { code: 0, stdout: '{}' };
    },
    cutoff: '2026-09-24T00:00:00Z',
    driveId: 'drive1',
    reviewsFolderId: 'reviews1',
    gh:
      gh ??
      (() => ({
        code: 0,
        stdout: JSON.stringify([
          {
            number: 40,
            title: 'feat: RT-1.1',
            headRefName: 'pu/rt-1-1',
            body: '',
            mergedAt: '2026-09-20T00:00:00Z',
          },
        ]),
      })),
    out: (text) => void output.push(text),
  };
  return { deps, calls, output };
}

describe('bun board:stale', () => {
  test('walks the configured drive and Reviews folder', () => {
    const { deps, calls } = fakes();
    runStaleCheck(deps, false);
    const trees = calls.filter((call) => call[1] === 'tree');
    assert({
      given: 'a drive id and Reviews folder id from project config',
      should: 'scope every tree walk to that drive and read reviews there',
      actual: [
        trees.every((call) => call[call.indexOf('--drive') + 1] === 'drive1'),
        trees.some((call) => call.includes('reviews1')),
      ],
      expected: [true, true],
    });
  });

  test('lists drift without changing anything by default', () => {
    const { deps, calls, output } = fakes();
    const code = runStaleCheck(deps, false);
    assert({
      given:
        'a merged task in progress and an unmerged Done task without a record',
      should: 'report both with their fix and update nothing',
      actual: [
        code,
        output.join('').includes('RT-1.1 merged but in_progress → merged'),
        output
          .join('')
          .includes('RT-1.2 Done without a review record → in_review'),
        output.join('').includes('RT-1.3'),
        calls.some((call) => call[1] === 'update'),
      ],
      expected: [0, true, true, false, false],
    });
  });

  test('applies pre-Done statuses once, creating Merged and never marking Done', () => {
    const { deps, calls } = fakes();
    runStaleCheck(deps, true);
    const writes = calls.filter(
      (call) => call[1] === 'update' || call[1] === 'create-status',
    );
    assert({
      given: '--apply',
      should:
        'create the Merged status and move each drifted task back before Done',
      actual: writes.map((call) => call.slice(0, 5).join(' ')),
      expected: [
        'tasks create-status phase1 --name Merged',
        'tasks update phase1 t1 --status',
        'tasks update phase1 t2 --status',
      ],
    });
    assert({
      given: '--apply',
      should: 'never set completed',
      actual: writes.some((call) => call.includes('completed')),
      expected: false,
    });
  });

  test('fails with a message when gh cannot list the merged PRs', () => {
    const { deps, calls, output } = fakes(() => ({ code: 1, stdout: '' }));
    assert({
      given: 'gh exiting non-zero, as outside a repository',
      should: 'exit 1 naming gh, before reading the board',
      actual: [runStaleCheck(deps, false), output.join(''), calls.length],
      expected: [1, 'gh pr list failed (exit 1); nothing was checked.\n', 0],
    });
  });
});
