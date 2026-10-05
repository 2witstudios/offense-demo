import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { runBoard, type BoardDeps } from './board';
import { contentHash } from './board-model';

setupRitewayBun();

const task = 'taskxxxxxxxxxxxxxxxxxxxx';
const list = 'listxxxxxxxxxxxxxxxxxxxx';
const plan = 'planxxxxxxxxxxxxxxxxxxxx';
const page = '<ul>\n<li>\nGiven A, should B\n</li>\n</ul>';

function fakeBoard(
  content = page,
  autonomous = false,
  // What every read after the first returns: a concurrent edit.
  edited?: string,
) {
  let reads = 0;
  const current = () =>
    reads++ === 0 || edited === undefined ? content : edited;
  const calls: string[][] = [];
  const written: string[] = [];
  const output: string[] = [];
  const deps: BoardDeps = {
    pagespace: (args) => {
      calls.push([...args]);
      const key = args.slice(0, 2).join(' ');
      if (key === 'pages read' && args.includes('--raw'))
        return { code: 0, stdout: content };
      if (key === 'pages read')
        return { code: 0, stdout: JSON.stringify({ content: current() }) };
      if (key === 'pages read-details')
        return {
          code: 0,
          stdout: JSON.stringify({
            title: args[2] === plan ? 'Plan — X' : 'Leaf',
            parentId: list,
          }),
        };
      if (key === 'tasks list')
        return {
          code: 0,
          stdout: JSON.stringify({
            tasks: [{ id: 'task-row', pageId: task, title: 'ISSUE-3 — a' }],
            availableStatuses: [{ slug: 'in_progress' }, { slug: 'in_review' }],
          }),
        };
      if (key === 'pages replace-lines') {
        written.push(readFileSync(args[args.indexOf('--file') + 1], 'utf8'));
        return { code: 0, stdout: '' };
      }
      return { code: 0, stdout: '{}' };
    },
    readFile: () => 'b',
    issueLists: () => ['issues', 'bugs', 'backlog'],
    autonomous,
    scratch: (name) => join(tmpdir(), `board-test-${process.pid}-${name}`),
    out: (text) => void output.push(text),
  };
  return { deps, calls, written, output };
}

describe('bun board:*', () => {
  test('reads a page raw, placeholders included', () => {
    const board = fakeBoard('<p>room:&lt;id&gt;:presence</p>');
    runBoard(board.deps, ['read', task]);
    assert({
      given: 'a page holding a placeholder',
      should: 'print the raw content unchanged',
      actual: board.output.join(''),
      expected: '<p>room:&lt;id&gt;:presence</p>',
    });
  });

  test('moves a task page to a status its list defines', () => {
    const board = fakeBoard();
    const code = runBoard(board.deps, ['status', task, 'in_review']);
    assert({
      given: 'a task page id and a valid status',
      should: 'update the task row in its parent list',
      actual: [code, board.calls.at(-1)],
      expected: [
        0,
        ['tasks', 'update', list, 'task-row', '--status', 'in_review'],
      ],
    });
  });

  test('refuses a status the list does not define', () => {
    const board = fakeBoard();
    assert({
      given: 'an unknown status slug',
      should: 'exit 1 without updating',
      actual: [
        runBoard(board.deps, ['status', task, 'merged']),
        board.calls.some((call) => call[1] === 'update'),
      ],
      expected: [1, false],
    });
  });

  test('refuses Done from an autonomous agent and allows it for the owner', () => {
    const agent = fakeBoard(page, true);
    const owner = fakeBoard();
    assert({
      given: 'board:status completed from an agent and from the owner',
      should:
        'refuse the agent before any call, naming the review record, and let the owner through to the list check',
      actual: [
        runBoard(agent.deps, ['status', task, 'completed']),
        agent.calls.length,
        agent.output.join('').includes('independent review record'),
        runBoard(owner.deps, ['status', task, 'completed']) !== 2 &&
          owner.calls.length > 0,
      ],
      expected: [2, 0, true, true],
    });
  });

  test('appends to Related pages with a concurrency guard', () => {
    const board = fakeBoard();
    runBoard(board.deps, ['relate', task, 'Plan', plan]);
    const replace = board.calls.find((call) => call[1] === 'replace-lines');
    assert({
      given: 'a leaf and a page to relate',
      should: 'write the page back guarded by its line count',
      actual: [
        replace?.slice(replace.indexOf('--expect-lines'), -2),
        board.written[0]?.endsWith(
          `Plan: <a class="mention" data-mention-type="page" data-page-id="${plan}">@Plan — X</a>\n</li>\n</ul>`,
        ),
      ],
      expected: [['--expect-lines', '5'], true],
    });
  });

  test('numbers a new issue after the highest one in any Issues bucket', () => {
    const board = fakeBoard();
    const lists: Record<string, { title: string; pageId: string }[]> = {
      issues: [{ title: 'ISSUE-3 — a', pageId: 'i3' }],
      bugs: [{ title: 'ISSUE-9 — b', pageId: 'i9' }],
      backlog: [{ title: 'TOURN-1 — c', pageId: 't1' }],
    };
    const base = board.deps.pagespace;
    const pagespace: BoardDeps['pagespace'] = (args) =>
      args[0] === 'tasks' && args[1] === 'list'
        ? { code: 0, stdout: JSON.stringify({ tasks: lists[args[2]] ?? [] }) }
        : base(args);
    runBoard({ ...board.deps, pagespace }, [
      'create',
      list,
      '--issue',
      '--title',
      'Given X, should Y',
    ]);
    assert({
      given: 'ISSUE-9 in Bugs and ISSUE-3 at the root of Issues',
      should: 'title the new issue ISSUE-10',
      actual: board.calls
        .find((call) => call[0] === 'tasks' && call[1] === 'create')
        ?.at(4),
      expected: 'ISSUE-10 — Given X, should Y',
    });
  });

  test('refuses a replace when the page changed underneath', () => {
    const board = fakeBoard();
    const code = runBoard(board.deps, [
      'replace',
      task,
      '--start',
      '2',
      '--end',
      '2',
      '--expect-lines',
      '9',
      '--file',
      'new.html',
      '--old-file',
      'old.html',
    ]);
    assert({
      given: 'an expected line count that no longer matches',
      should: 'exit 1 without sending the replace',
      actual: [code, board.calls.some((call) => call[1] === 'replace-lines')],
      expected: [1, false],
    });
  });

  test('refuses relate and replace when a concurrent edit kept the line count', () => {
    const same = page.replace('Given A, should B', 'Given A, should C');
    const relate = fakeBoard(page, false, same);
    const replaced = fakeBoard(page, false, same);
    const replaceArgs = [
      'replace',
      task,
      '--start',
      '3',
      '--end',
      '3',
      '--expect-lines',
      '5',
      '--file',
      'new.html',
      '--expect-hash',
      contentHash(page),
    ];
    assert({
      given:
        'a page edited between the read and the write, with the same number of lines',
      should: 'exit 1 and send no write',
      actual: [
        runBoard(relate.deps, ['relate', task, 'Plan', plan]),
        relate.calls.some((call) => call[1] === 'replace-lines'),
        runBoard(replaced.deps, replaceArgs),
        replaced.calls.some((call) => call[1] === 'replace-lines'),
      ],
      expected: [1, false, 1, false],
    });
  });

  test('replaces only a page whose content hash matches the one the caller read', () => {
    const stale = fakeBoard();
    const fresh = fakeBoard();
    const file = join(tmpdir(), `board-test-${process.pid}-hash.html`);
    writeFileSync(file, 'Given A, should C');
    const args = (hash: string) => [
      'replace',
      task,
      '--start',
      '3',
      '--end',
      '3',
      '--expect-lines',
      '5',
      '--expect-hash',
      hash,
      '--file',
      file,
    ];
    assert({
      given:
        'an --expect-hash from an older read, and one from the current page',
      should: 'refuse the stale one and send the current one',
      actual: [
        runBoard(stale.deps, args('0'.repeat(64))),
        stale.calls.some((call) => call[1] === 'replace-lines'),
        runBoard(fresh.deps, args(contentHash(page))),
        fresh.calls.some((call) => call[1] === 'replace-lines'),
      ],
      expected: [1, false, 0, true],
    });
    rmSync(file, { force: true });
  });

  test('prints the content hash a later replace can expect', () => {
    const board = fakeBoard();
    assert({
      given: 'bun board:hash <pageId>',
      should: 'print the SHA3-256 of the page content',
      actual: [runBoard(board.deps, ['hash', task]), board.output.join('')],
      expected: [0, `${contentHash(page)}\n`],
    });
  });

  test('prints usage for malformed arguments', () => {
    const board = fakeBoard();
    assert({
      given: 'an unknown command',
      should: 'exit 2 and call nothing',
      actual: [runBoard(board.deps, ['nuke', task]), board.calls.length],
      expected: [2, 0],
    });
  });
});
