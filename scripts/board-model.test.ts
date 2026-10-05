import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  appendRelated,
  findTask,
  leafBody,
  nextCodeNumber,
  parseBoardArgs,
} from './board-model';

setupRitewayBun();

const id = 'taskxxxxxxxxxxxxxxxxxxxx';

describe('parseBoardArgs', () => {
  test('parses each command and rejects malformed input', () => {
    assert({
      given: 'valid read, status, relate, create and replace invocations',
      should: 'return typed commands',
      actual: [
        parseBoardArgs(['read', id]),
        parseBoardArgs(['status', id, 'in_review']),
        parseBoardArgs(['relate', id, 'Review', 'planxxxxxxxxxxxxxxxxxxxx']),
        parseBoardArgs([
          'create',
          'issuesxxxxxxxxxxxxxxxxxx',
          '--issue',
          '--title',
          'Given X, should Y',
          '--criterion',
          'Given A, should B',
          '--related',
          'Origin=planxxxxxxxxxxxxxxxxxxxx',
        ]),
        parseBoardArgs([
          'replace',
          id,
          '--start',
          '3',
          '--end',
          '4',
          '--expect-lines',
          '40',
          '--file',
          'new.html',
          '--old-file',
          'old.html',
        ]),
      ],
      expected: [
        { command: 'read', pageId: id },
        { command: 'status', pageId: id, status: 'in_review' },
        {
          command: 'relate',
          pageId: id,
          label: 'Review',
          target: 'planxxxxxxxxxxxxxxxxxxxx',
        },
        {
          command: 'create',
          listId: 'issuesxxxxxxxxxxxxxxxxxx',
          prefix: 'ISSUE',
          title: 'Given X, should Y',
          criteria: ['Given A, should B'],
          related: [{ label: 'Origin', id: 'planxxxxxxxxxxxxxxxxxxxx' }],
        },
        {
          command: 'replace',
          pageId: id,
          start: 3,
          end: 4,
          expectLines: 40,
          file: 'new.html',
          oldFile: 'old.html',
        },
      ],
    });
  });

  test('refuses unsafe or malformed arguments with a usage message', () => {
    const errors = [
      parseBoardArgs(['read', '../etc/passwd']),
      parseBoardArgs(['status', id, 'In Review']),
      parseBoardArgs(['replace', id, '--start', '3', '--file', 'x']),
      parseBoardArgs(['create', id, '--title', 'x', '--related', 'bad']),
      parseBoardArgs(['create', id]),
      parseBoardArgs(['launch']),
    ].map((result) => 'error' in result);
    assert({
      given:
        'a non-id page, a label instead of a slug, a replace without --expect-lines, a bad related entry, a missing title and an unknown command',
      should: 'return an error for each',
      actual: errors,
      expected: [true, true, true, true, true, true],
    });
  });
});

describe('parseBoardArgs flag handling', () => {
  const list = 'issuesxxxxxxxxxxxxxxxxxx';
  const target = 'planxxxxxxxxxxxxxxxxxxxx';
  const firstLine = (argv: string[]) => {
    const parsed = parseBoardArgs(argv);
    return 'error' in parsed ? parsed.error.split('\n')[0] : parsed;
  };

  test('refuses unknown flags, missing values and stray arguments', () => {
    assert({
      given:
        'a typo flag, --related in = form with a malformed value, --file with no value, and a second list id',
      should: 'return an error naming each problem, never drop it',
      actual: [
        firstLine(['create', list, '--title', 'x', '--criteria', 'Given A']),
        firstLine(['create', list, '--title', 'x', '--related=Origin']),
        firstLine([
          'replace',
          id,
          '--start',
          '1',
          '--end',
          '1',
          '--expect-lines',
          '1',
          '--file',
        ]),
        firstLine(['create', list, list, '--title', 'x']),
      ],
      expected: [
        'Unknown flag --criteria',
        '--related takes Label=<pageId>',
        '--file needs a value',
        `Unexpected argument ${list}`,
      ],
    });
  });

  test('reads a flag and its value joined by =', () => {
    assert({
      given: '--related=Origin=<pageId> and --title=<text>',
      should: 'read them as the separate forms',
      actual: firstLine([
        'create',
        list,
        '--title=Given X, should Y',
        `--related=Origin=${target}`,
      ]),
      expected: {
        command: 'create',
        listId: list,
        prefix: undefined,
        title: 'Given X, should Y',
        criteria: [],
        related: [{ label: 'Origin', id: target }],
      },
    });
  });
});

describe('parseBoardArgs guards', () => {
  const replace = [
    'replace',
    id,
    '--start',
    '1',
    '--end',
    '1',
    '--expect-lines',
    '1',
    '--file',
    'f',
  ];
  const firstLine = (argv: string[]) => {
    const parsed = parseBoardArgs(argv);
    return 'error' in parsed ? parsed.error.split('\n')[0] : 'ok';
  };

  test('requires a replace to prove what it read, and refuses repeated flags and hex numbers', () => {
    assert({
      given:
        'a replace with neither --expect-hash nor --old-file, a repeated --title, and --start 0x1',
      should: 'refuse each with its reason',
      actual: [
        firstLine(replace),
        firstLine([
          'create',
          'issuesxxxxxxxxxxxxxxxxxx',
          '--title',
          'a',
          '--title',
          'b',
        ]),
        firstLine([
          ...replace.map((arg) => (arg === '1' ? '0x1' : arg)),
          '--old-file',
          'o',
        ]),
      ],
      expected: [
        'replace needs --expect-hash (from bun board:hash) or --old-file (the lines as you read them)',
        '--title given twice',
        'replace needs a page id, --start, --end, --expect-lines and --file',
      ],
    });
  });
});

describe('findTask', () => {
  test('finds the task row that owns a task page', () => {
    const list = {
      tasks: [
        { id: 't1', pageId: 'p1', title: 'A' },
        { id: 't2', pageId: 'p2', title: 'B' },
      ],
      availableStatuses: [{ slug: 'in_review' }],
    };
    assert({
      given: 'a task list and a task page id',
      should: 'return the task id and the valid status slugs',
      actual: [findTask(list, 'p2'), findTask(list, 'p9')],
      expected: [{ taskId: 't2', statuses: ['in_review'] }, undefined],
    });
  });
});

describe('nextCodeNumber', () => {
  test('continues after the highest ISSUE-n', () => {
    assert({
      given: 'issue titles out of order plus a non-issue',
      should: 'return one more than the highest number',
      actual: [
        nextCodeNumber(
          ['ISSUE-2 — a', 'ISSUE-14 — b', 'Other', 'ISSUE-9 — c', 'DEC-40 — d'],
          'ISSUE',
        ),
        nextCodeNumber(['ISSUE-2 — a'], 'DEC'),
      ],
      expected: [15, 1],
    });
  });
});

describe('leafBody and appendRelated', () => {
  const body = leafBody({
    criteria: ['Given <a>, should "b"'],
    related: [{ label: 'Origin', id: 'p1', title: 'PR & review' }],
  });

  test('writes criteria bullets above an escaped Related pages block', () => {
    assert({
      given: 'a criterion and a related page',
      should: 'escape HTML and mention the page',
      actual: body,
      expected: [
        '<ul>',
        '<li>',
        'Given &lt;a&gt;, should &quot;b&quot;',
        '</li>',
        '</ul>',
        '<h3>',
        'Related pages',
        '</h3>',
        '<ul>',
        '<li>',
        'Origin: <a class="mention" data-mention-type="page" data-page-id="p1">@PR &amp; review</a>',
        '</li>',
        '</ul>',
      ].join('\n'),
    });
  });

  test('appends to the Related pages block without touching criteria', () => {
    const appended = appendRelated(body, {
      label: 'Review',
      id: 'p2',
      title: 'Review record',
    });
    assert({
      given: 'a page with a Related pages block',
      should: 'add one entry at the end of that block only',
      actual: [
        appended.startsWith(body.slice(0, body.lastIndexOf('</ul>'))),
        appended.endsWith(
          '<li>\nReview: <a class="mention" data-mention-type="page" data-page-id="p2">@Review record</a>\n</li>\n</ul>',
        ),
      ],
      expected: [true, true],
    });
  });

  test('adds a Related pages block when the page has none', () => {
    assert({
      given: 'a page without the block',
      should: 'append a new block',
      actual: appendRelated('<p>x</p>', {
        label: 'Plan',
        id: 'p3',
        title: 'P',
      }),
      expected:
        '<p>x</p>\n<h3>\nRelated pages\n</h3>\n<ul>\n<li>\nPlan: <a class="mention" data-mention-type="page" data-page-id="p3">@P</a>\n</li>\n</ul>',
    });
  });

  test('keeps placeholders that look like tags intact', () => {
    assert({
      given: 'a page whose text holds room:<id>:presence',
      should: 'leave it byte for byte',
      actual: appendRelated('<p>room:&lt;id&gt;:presence</p>', {
        label: 'Plan',
        id: 'p3',
        title: 'P',
      }).startsWith('<p>room:&lt;id&gt;:presence</p>'),
      expected: true,
    });
  });
});
