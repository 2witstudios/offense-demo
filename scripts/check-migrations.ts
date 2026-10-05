import { resolve } from 'node:path';

import { isIsoDate, reviewDateStatus, utcToday } from './review-date';

/**
 * `bun migrations:check` (ADR 0038): the drizzle-kit 1.0 migration folder
 * is `packages/db/migrations/<14-digit timestamp>_<name>/` holding exactly
 * `migration.sql` and `snapshot.json`, applied in name order. This check
 * reads the committed trees of HEAD and its merge base with the base ref
 * and fails anything the migrator would silently skip or that rewrites
 * shared history.
 */

const migrationsDir = 'packages/db/migrations';
const root = resolve(import.meta.dir, '..');
const tagPattern = /^\d{14}_[a-z0-9_]+$/;
/** drizzle-kit 1.0's `prevIds` entry for the first migration. */
const originSnapshotId = '00000000-0000-0000-0000-000000000000';

export type MigrationProblemCode =
  | 'STRAY_FILE'
  | 'ORPHAN_SNAPSHOT'
  | 'MISSING_SNAPSHOT'
  | 'DUPLICATE_TIMESTAMP'
  | 'TRUNCATED_HISTORY'
  | 'REWRITTEN_HISTORY'
  | 'REWRITTEN_SQL'
  | 'REWRITTEN_SNAPSHOT'
  | 'BROKEN_CHAIN'
  | 'BASE_LAYOUT'
  | 'EXPIRED_SANCTION'
  | 'INVALID_SANCTION';

export type MigrationProblem = {
  readonly code: MigrationProblemCode;
  readonly detail: string;
};

/** One committed file under the migrations folder: its path there and blob id. */
export type TreeFile = { readonly path: string; readonly blob: string };

export type Migration = {
  readonly tag: string;
  readonly sql: string;
  readonly snapshot: string;
};

export type SnapshotLink = {
  readonly tag: string;
  readonly id: string;
  readonly prevIds: readonly string[];
};

export type SanctionedBaseline = {
  readonly baseMigrationsHash: string;
  readonly adr: string;
  /** Untrusted policy-file value; only a valid, unexpired ISO date excuses. */
  readonly reviewBy?: unknown;
};

export type MigrationCheckReport = {
  readonly ok: boolean;
  readonly sanctioned: boolean;
  readonly baseRef: string;
  readonly baseCount: number;
  readonly headCount: number;
  readonly problems: readonly MigrationProblem[];
};

export const parseBaseRef = (argv: readonly string[]): string =>
  argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'origin/main';

/** Parses `git ls-tree -r <ref> -- packages/db/migrations` output. */
export function parseLsTree(output: string): readonly TreeFile[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta = '', path = ''] = line.split('\t');
      const blob = meta.split(' ')[2] ?? '';
      return { path: path.slice(`${migrationsDir}/`.length), blob };
    });
}

/**
 * The migrations a tree holds, in apply order, and every file the migrator
 * would skip: anything outside `<tag>/migration.sql` and `<tag>/snapshot.json`
 * (the drizzle-kit 0.x `meta/` journal included), a snapshot with no SQL
 * beside it, and SQL with no snapshot for the next `generate` to diff.
 */
export function readMigrations(files: readonly TreeFile[]): {
  readonly migrations: readonly Migration[];
  readonly problems: readonly MigrationProblem[];
} {
  const problems: MigrationProblem[] = [];
  const byTag = new Map<string, { sql?: string; snapshot?: string }>();
  for (const { path, blob } of files) {
    const [tag = '', file, ...rest] = path.split('/');
    const kind =
      file === 'migration.sql'
        ? 'sql'
        : file === 'snapshot.json'
          ? 'snapshot'
          : undefined;
    if (!tagPattern.test(tag) || kind === undefined || rest.length > 0) {
      problems.push({
        code: 'STRAY_FILE',
        detail: `${migrationsDir}/${path} is not <timestamp>_<name>/migration.sql or snapshot.json; the migrator never reads it`,
      });
      continue;
    }
    byTag.set(tag, { ...byTag.get(tag), [kind]: blob });
  }
  const migrations: Migration[] = [];
  for (const [tag, { sql, snapshot }] of [...byTag].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (sql === undefined)
      problems.push({
        code: 'ORPHAN_SNAPSHOT',
        detail: `${migrationsDir}/${tag}/snapshot.json has no migration.sql beside it`,
      });
    else if (snapshot === undefined)
      problems.push({
        code: 'MISSING_SNAPSHOT',
        detail: `${migrationsDir}/${tag}/migration.sql has no snapshot.json beside it`,
      });
    else migrations.push({ tag, sql, snapshot });
  }
  const stamps = new Map<string, string>();
  for (const { tag } of migrations) {
    const stamp = tag.slice(0, 14);
    const other = stamps.get(stamp);
    if (other)
      problems.push({
        code: 'DUPLICATE_TIMESTAMP',
        detail: `${other} and ${tag} share the timestamp ${stamp}`,
      });
    stamps.set(stamp, tag);
  }
  return { migrations, problems };
}

/** Shared migrations must stay exactly as committed on the base, in order. */
export function findHistoryProblems(
  base: readonly Migration[],
  head: readonly Migration[],
): readonly MigrationProblem[] {
  return base.flatMap((migration, index): MigrationProblem[] => {
    const current = head[index];
    if (current === undefined)
      return [
        {
          code: 'TRUNCATED_HISTORY',
          detail: `base migration ${migration.tag} is missing from this branch`,
        },
      ];
    if (current.tag !== migration.tag)
      return [
        {
          code: 'REWRITTEN_HISTORY',
          detail: `base migration ${migration.tag} no longer at position ${index} (found ${current.tag})`,
        },
      ];
    return [
      ...(current.sql === migration.sql
        ? []
        : [
            {
              code: 'REWRITTEN_SQL' as const,
              detail: `shared migration ${migration.tag}/migration.sql was rewritten on this branch`,
            },
          ]),
      ...(current.snapshot === migration.snapshot
        ? []
        : [
            {
              code: 'REWRITTEN_SNAPSHOT' as const,
              detail: `shared migration ${migration.tag}/snapshot.json was rewritten on this branch`,
            },
          ]),
    ];
  });
}

/** Each snapshot names its predecessor's id in `prevIds`; the first names none. */
export function findChainProblems(
  links: readonly SnapshotLink[],
): readonly MigrationProblem[] {
  return links.flatMap(({ tag, prevIds }, index): MigrationProblem[] => {
    const expected = index === 0 ? originSnapshotId : links[index - 1]?.id;
    return expected !== undefined && prevIds.includes(expected)
      ? []
      : [
          {
            code: 'BROKEN_CHAIN',
            detail: `${tag}/snapshot.json prevIds ${JSON.stringify(prevIds)} does not name ${expected ?? 'its predecessor'}`,
          },
        ];
  });
}

export function parseSnapshotLink(tag: string, json: string): SnapshotLink {
  const parsed = JSON.parse(json) as { id?: unknown; prevIds?: unknown };
  const prevIds = Array.isArray(parsed.prevIds)
    ? parsed.prevIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { tag, id: typeof parsed.id === 'string' ? parsed.id : '', prevIds };
}

/**
 * The fingerprint a squash sanction records: every committed path and blob
 * under the migrations folder at the replaced base, whatever its layout.
 */
export const migrationsFingerprint = (files: readonly TreeFile[]): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(({ path, blob }) => `${blob} ${path}`)
      .join('\n'),
  );
  return `sha256:${hasher.digest('hex')}`;
};

export const baselinesPath = 'policy/migration-baselines.json';

/** Same rule as `bun policy`: a sanction is live through its reviewBy day. */
const sanctionProblem = (
  { adr, reviewBy }: SanctionedBaseline,
  today: string,
): MigrationProblem | null => {
  if (!isIsoDate(reviewBy))
    return {
      code: 'INVALID_SANCTION',
      detail: `${baselinesPath} sanction for this base needs an ISO reviewBy date (YYYY-MM-DD); an undated sanction never excuses a rewrite`,
    };
  if (reviewDateStatus(reviewBy, today) === 'expired')
    return {
      code: 'EXPIRED_SANCTION',
      detail: `${baselinesPath} sanction for this base expired on ${reviewBy} (today is ${today}); renew it through ${adr} or drop the rewrite`,
    };
  return null;
};

/**
 * A sanctioned baseline squash (ADR 0023, ADR 0038) is the one allowed way
 * to replace committed history. The sanction records the fingerprint of the
 * replaced base tree, so it is inert once the squash lands. It excuses only
 * the comparison with that base; the new tree must still be valid on its
 * own.
 */
export function evaluateMigrations(options: {
  readonly baseFiles: readonly TreeFile[];
  readonly headFiles: readonly TreeFile[];
  readonly headLinks: readonly SnapshotLink[];
  readonly baselines: readonly SanctionedBaseline[];
  /** UTC calendar day (YYYY-MM-DD), injected by the caller. */
  readonly today: string;
}): {
  readonly problems: readonly MigrationProblem[];
  readonly sanctioned: boolean;
  readonly baseCount: number;
  readonly headCount: number;
} {
  const base = readMigrations(options.baseFiles);
  const head = readMigrations(options.headFiles);
  const own = [...head.problems, ...findChainProblems(options.headLinks)];
  const fingerprint = migrationsFingerprint(options.baseFiles);
  const sanctions = options.baselines
    .filter(({ baseMigrationsHash }) => baseMigrationsHash === fingerprint)
    .map((baseline) => sanctionProblem(baseline, options.today));
  const counts = {
    baseCount: base.migrations.length,
    headCount: head.migrations.length,
  };
  if (sanctions.includes(null))
    return { problems: own, sanctioned: true, ...counts };
  const history =
    base.problems.length > 0
      ? [
          {
            code: 'BASE_LAYOUT' as const,
            detail: `the base ref's migrations are not in the drizzle-kit 1.0 layout (${base.problems.length} unreadable files); rebase onto it`,
          },
        ]
      : findHistoryProblems(base.migrations, head.migrations);
  return {
    problems: [
      ...own,
      ...history,
      ...sanctions.filter((problem) => problem !== null),
    ],
    sanctioned: false,
    ...counts,
  };
}

export function formatMigrationCheckReport(
  report: MigrationCheckReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  if (report.ok)
    return [
      `Migrations: PASS (${report.headCount} committed, base ${report.baseCount} from ${report.baseRef})`,
      ...(report.sanctioned
        ? [
            `  Sanctioned baseline squash applied (${baselinesPath});`,
            '  every pre-existing local and test database must be reset once.',
          ]
        : []),
      '',
    ].join('\n');
  return [
    'Migrations: FAIL',
    ...report.problems.map(({ code, detail }) => `  ${code}: ${detail}`),
    '  Applied migrations are immutable: never rewrite, reorder, or remove',
    '  committed migrations. Rebase onto the base ref, then regenerate the',
    '  conflicting tail with `bun db:generate` as a forward correction.',
    '',
  ].join('\n');
}

async function git(args: readonly string[]): Promise<string> {
  try {
    return await Bun.$`git ${args}`.cwd(root).quiet().text();
  } catch {
    throw new Error(
      `git ${args.join(' ')} failed; fetch the base ref first (git fetch origin)`,
    );
  }
}

const treeAt = async (ref: string) =>
  parseLsTree(await git(['ls-tree', '-r', ref, '--', migrationsDir]));

export const readSanctionedBaselines = async (): Promise<
  readonly SanctionedBaseline[]
> => {
  const file = Bun.file(resolve(root, baselinesPath));
  if (!(await file.exists())) return [];
  const parsed = (await file.json()) as { baselines?: unknown };
  if (!Array.isArray(parsed.baselines)) return [];
  return parsed.baselines.filter(
    (entry): entry is SanctionedBaseline =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as SanctionedBaseline).baseMigrationsHash === 'string' &&
      typeof (entry as SanctionedBaseline).adr === 'string',
  );
};

export async function runMigrationCheck(
  baseRef = parseBaseRef(process.argv),
  today = utcToday(),
): Promise<MigrationCheckReport> {
  const mergeBase = (await git(['merge-base', 'HEAD', baseRef])).trim();
  const baseFiles = await treeAt(mergeBase);
  const headFiles = await treeAt('HEAD');
  const headLinks = await Promise.all(
    readMigrations(headFiles).migrations.map(async ({ tag, snapshot }) =>
      parseSnapshotLink(tag, await git(['cat-file', '-p', snapshot])),
    ),
  );
  const result = evaluateMigrations({
    baseFiles,
    headFiles,
    headLinks,
    baselines: await readSanctionedBaselines(),
    today,
  });
  return {
    ok: result.problems.length === 0,
    sanctioned: result.sanctioned,
    baseRef,
    baseCount: result.baseCount,
    headCount: result.headCount,
    problems: result.problems,
  };
}

if (import.meta.main) {
  try {
    const report = await runMigrationCheck();
    process.stdout.write(
      formatMigrationCheckReport(report, process.argv.includes('--json')),
    );
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Migration check failed'}\n`,
    );
    process.exitCode = 1;
  }
}
