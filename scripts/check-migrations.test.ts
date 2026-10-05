import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  evaluateMigrations,
  findChainProblems,
  findHistoryProblems,
  formatMigrationCheckReport,
  migrationsFingerprint,
  parseBaseRef,
  parseLsTree,
  parseSnapshotLink,
  readMigrations,
  type TreeFile,
} from './check-migrations';

setupRitewayBun();

const first = '20260101000000_baseline';
const second = '20260102000000_add_debates';
const folder = (tag: string, sql = `${tag}-sql`, snapshot = `${tag}-snap`) => [
  { path: `${tag}/migration.sql`, blob: sql },
  { path: `${tag}/snapshot.json`, blob: snapshot },
];
const codes = (problems: readonly { code: string }[]) =>
  problems.map(({ code }) => code);
const origin = '00000000-0000-0000-0000-000000000000';
const links = [
  { tag: first, id: 'a', prevIds: [origin] },
  { tag: second, id: 'b', prevIds: ['a'] },
];

describe('parseLsTree', () => {
  test('reads each committed path under the migrations folder with its blob', () => {
    assert({
      given: 'git ls-tree -r output for the migrations folder',
      should: 'return folder-relative paths and blob ids',
      actual: parseLsTree(
        `100644 blob abc123\tpackages/db/migrations/${first}/migration.sql\n100644 blob def456\tpackages/db/migrations/${first}/snapshot.json\n`,
      ),
      expected: [
        { path: `${first}/migration.sql`, blob: 'abc123' },
        { path: `${first}/snapshot.json`, blob: 'def456' },
      ],
    });
  });
});

describe('readMigrations', () => {
  test('orders complete migration folders by name', () => {
    assert({
      given: 'two complete folders listed out of order',
      should: 'return both in apply order with no problems',
      actual: readMigrations([...folder(second), ...folder(first)]),
      expected: {
        migrations: [
          { tag: first, sql: `${first}-sql`, snapshot: `${first}-snap` },
          { tag: second, sql: `${second}-sql`, snapshot: `${second}-snap` },
        ],
        problems: [],
      },
    });
  });

  test('fails a snapshot that no migration.sql accompanies (ISSUE-6)', () => {
    assert({
      given: 'a folder holding only snapshot.json, which the migrator skips',
      should: 'report an orphan snapshot and not count it as a migration',
      actual: (() => {
        const { migrations, problems } = readMigrations([
          ...folder(first),
          { path: `${second}/snapshot.json`, blob: 'x' },
        ]);
        return {
          tags: migrations.map(({ tag }) => tag),
          codes: codes(problems),
        };
      })(),
      expected: { tags: [first], codes: ['ORPHAN_SNAPSHOT'] },
    });
  });

  test('fails files outside the folder layout, including a legacy meta journal and snapshot', () => {
    assert({
      given: 'drizzle-kit 0.x meta files and a loose SQL file',
      should: 'report each as a stray file',
      actual: codes(
        readMigrations([
          ...folder(first),
          { path: 'meta/_journal.json', blob: 'j' },
          { path: 'meta/0005_snapshot.json', blob: 's' },
          { path: '0000_old.sql', blob: 'o' },
          { path: `${first}/notes.md`, blob: 'n' },
        ]).problems,
      ),
      expected: ['STRAY_FILE', 'STRAY_FILE', 'STRAY_FILE', 'STRAY_FILE'],
    });
  });

  test('fails SQL without a snapshot and two folders sharing a timestamp', () => {
    assert({
      given: 'a migration.sql alone and a parallel-generated duplicate stamp',
      should: 'report the missing snapshot and the duplicate timestamp',
      actual: codes(
        readMigrations([
          ...folder(first),
          ...folder('20260101000000_parallel'),
          { path: `${second}/migration.sql`, blob: 'x' },
        ]).problems,
      ),
      expected: ['MISSING_SNAPSHOT', 'DUPLICATE_TIMESTAMP'],
    });
  });
});

describe('findHistoryProblems', () => {
  const base = readMigrations(folder(first)).migrations;

  test('accepts an appended migration', () => {
    assert({
      given: 'the base migration unchanged and a new one after it',
      should: 'report nothing',
      actual: findHistoryProblems(
        base,
        readMigrations([...folder(first), ...folder(second)]).migrations,
      ),
      expected: [],
    });
  });

  test('flags removed, reordered and rewritten shared migrations', () => {
    assert({
      given: 'a removed, a displaced, and a rewritten shared migration',
      should: 'report truncation, rewritten history, SQL and snapshot',
      actual: [
        codes(findHistoryProblems(base, [])),
        codes(
          findHistoryProblems(
            base,
            readMigrations([
              ...folder('20251231000000_earlier'),
              ...folder(first),
            ]).migrations,
          ),
        ),
        codes(
          findHistoryProblems(
            base,
            readMigrations(folder(first, 'edited', 'edited')).migrations,
          ),
        ),
      ],
      expected: [
        ['TRUNCATED_HISTORY'],
        ['REWRITTEN_HISTORY'],
        ['REWRITTEN_SQL', 'REWRITTEN_SNAPSHOT'],
      ],
    });
  });
});

describe('findChainProblems', () => {
  test('accepts a snapshot chain from the origin id', () => {
    assert({
      given: 'each snapshot naming its predecessor',
      should: 'report nothing',
      actual: findChainProblems(links),
      expected: [],
    });
  });

  test('flags a first snapshot with a predecessor and a broken link', () => {
    assert({
      given:
        'a first snapshot claiming a predecessor and a second naming the wrong one',
      should: 'report both breaks',
      actual: codes(
        findChainProblems([
          { tag: first, id: 'a', prevIds: ['z'] },
          { tag: second, id: 'b', prevIds: ['z'] },
        ]),
      ),
      expected: ['BROKEN_CHAIN', 'BROKEN_CHAIN'],
    });
  });

  test('reads id and prevIds from a drizzle-kit 1.0 snapshot', () => {
    assert({
      given: 'snapshot JSON',
      should: 'return its id and prevIds',
      actual: parseSnapshotLink(
        first,
        `{"version":"8","id":"a","prevIds":["${origin}"],"ddl":[]}`,
      ),
      expected: { tag: first, id: 'a', prevIds: [origin] },
    });
  });
});

describe('migrationsFingerprint', () => {
  test('is independent of listing order and sensitive to content', () => {
    const files: TreeFile[] = folder(first);
    assert({
      given: 'the same tree listed in two orders, and an edited blob',
      should: 'fingerprint the same tree identically and the edit differently',
      actual: [
        migrationsFingerprint(files) ===
          migrationsFingerprint([...files].reverse()),
        migrationsFingerprint(files) ===
          migrationsFingerprint(folder(first, 'edited')),
      ],
      expected: [true, false],
    });
  });
});

describe('evaluateMigrations', () => {
  const legacy: TreeFile[] = [
    { path: '0000_old.sql', blob: 'o' },
    { path: 'meta/_journal.json', blob: 'j' },
  ];
  const head = folder(first);
  const headLinks = [links[0]!];
  const sanction = (reviewBy: unknown, files = legacy) => ({
    baseMigrationsHash: migrationsFingerprint(files),
    adr: 'docs/decisions/0038-drizzle-1-baseline.md',
    reviewBy,
  });
  const today = '2026-09-23';

  test('excuses replacing the recorded base tree only while the sanction is live', () => {
    assert({
      given: 'a legacy base replaced by one baseline',
      should:
        'pass with a live sanction, fail when expired, undated or missing',
      actual: [
        [sanction('2026-09-23')],
        [sanction('2026-09-22')],
        [sanction(undefined)],
        [],
        [sanction('2026-12-31', head)],
      ].map((baselines) => {
        const result = evaluateMigrations({
          baseFiles: legacy,
          headFiles: head,
          headLinks,
          baselines,
          today,
        });
        return [result.sanctioned, codes(result.problems)];
      }),
      expected: [
        [true, []],
        [false, ['BASE_LAYOUT', 'EXPIRED_SANCTION']],
        [false, ['BASE_LAYOUT', 'INVALID_SANCTION']],
        [false, ['BASE_LAYOUT']],
        [false, ['BASE_LAYOUT']],
      ],
    });
  });

  test('never excuses a broken new tree, even when sanctioned', () => {
    const result = evaluateMigrations({
      baseFiles: legacy,
      headFiles: [...head, { path: `${second}/snapshot.json`, blob: 'x' }],
      headLinks: [{ tag: first, id: 'a', prevIds: ['z'] }],
      baselines: [sanction('2026-12-31')],
      today,
    });
    assert({
      given:
        'a sanctioned squash whose tree has an orphan snapshot and a broken chain',
      should: 'still fail on both',
      actual: codes(result.problems),
      expected: ['ORPHAN_SNAPSHOT', 'BROKEN_CHAIN'],
    });
  });

  test('compares an ordinary branch against its base', () => {
    const result = evaluateMigrations({
      baseFiles: head,
      headFiles: [...folder(first, 'edited'), ...folder(second)],
      headLinks: links,
      baselines: [],
      today,
    });
    assert({
      given: 'a branch that edits the shared baseline and appends a migration',
      should: 'report the rewritten SQL and count both trees',
      actual: {
        problems: codes(result.problems),
        counts: [result.baseCount, result.headCount],
      },
      expected: { problems: ['REWRITTEN_SQL'], counts: [1, 2] },
    });
  });
});

describe('report', () => {
  test('names the base ref and each problem', () => {
    assert({
      given: 'a failing report and the default base ref',
      should: 'print FAIL with each coded problem, defaulting to origin/main',
      actual: [
        parseBaseRef(['bun', 'check-migrations.ts', '--json']),
        formatMigrationCheckReport(
          {
            ok: false,
            sanctioned: false,
            baseRef: 'origin/main',
            baseCount: 1,
            headCount: 1,
            problems: [{ code: 'ORPHAN_SNAPSHOT', detail: 'x' }],
          },
          false,
        ).split('\n')[1],
      ],
      expected: ['origin/main', '  ORPHAN_SNAPSHOT: x'],
    });
  });
});
