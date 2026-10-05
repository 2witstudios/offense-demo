#!/usr/bin/env bun
/**
 * Runs a workspace's integration suites, discovered by folder and suffix
 * (`integration/**` + `*.integration.ts`) instead of
 * a hand-kept list in package.json. Bun's runner does not match the
 * `.integration.ts` suffix from a directory argument, so the files are
 * globbed here and passed explicitly. `bun evidence` treats this runner as
 * claiming every suite in the workspace's integration folder.
 */
import { constants } from 'node:os';
import { RedisClient, SQL } from 'bun';
import { requireTestSlotServices } from '@offense-demo/config';
import { sweepIdleNamespaces } from '@offense-demo/redis/namespaces';
import { deleteAllKeysWithoutExpiry } from './redis-whole-database';
import {
  TEST_NAMESPACE_PREFIX,
  TEST_RUN_MAX_MS,
} from '@offense-demo/redis/testing';
import { superviseRun, withRunDatabase } from './test-run-database';

export const INTEGRATION_RUNNER = 'bun ../../scripts/test-integration.ts';

const SUITE = /(?:^|\/)integration\/(?:.+\/)?[^/]+\.integration\.tsx?$/;

export const integrationSuites = (files: readonly string[]): string[] =>
  files.filter((file) => SUITE.test(file)).sort();

/** The integration suites under a workspace directory, .ts and .tsx. */
export const discoverSuites = (cwd: string): string[] =>
  integrationSuites([
    ...new Bun.Glob('integration/**/*.{ts,tsx}').scanSync(cwd),
  ]);

/**
 * The exit code for a finished run. A run killed by a signal has no exit
 * code, and exiting with none would report success; it exits 128 + the
 * signal number, as a shell does.
 */
export function exitCodeOf(result: {
  readonly exitCode: number | null;
  readonly signalCode?: string | null;
}): number {
  if (result.exitCode !== null) return result.exitCode;
  const signal =
    constants.signals[
      (result.signalCode ?? '') as keyof typeof constants.signals
    ];
  return signal === undefined ? 1 : 128 + signal;
}

// A repository path the runner reaches: <apps|packages>/<name>/integration/….
const RUNNER_SUITE =
  /^[^/]+\/[^/]+\/integration\/(?:.+\/)?[^/]+\.integration\.tsx?$/;

/**
 * Whether a workspace's test:integration script runs this suite, given its
 * repository path. The runner scans only the workspace's own integration/
 * folder, so a nested src/…/integration/ suite is not claimed.
 */
export function claimsIntegrationSuite(script: string, file: string): boolean {
  return script === INTEGRATION_RUNNER
    ? RUNNER_SUITE.test(file)
    : script.includes(file.split('/').pop() ?? file);
}

type RowCounts = Readonly<Record<string, number>>;

/**
 * ISSUE-192: every table a run left with more rows than it started with.
 * Suites remove exactly what they create, so a table that grew is a leak:
 * leaked rows accumulate run over run and slow every later run.
 */
export const grownTables = (before: RowCounts, after: RowCounts) =>
  Object.entries(after)
    .filter(([table, rows]) => rows > (before[table] ?? 0))
    .map(([table, rows]) => ({
      table,
      before: before[table] ?? 0,
      after: rows,
    }))
    .sort((a, b) => a.table.localeCompare(b.table));

/** The line for a pre-run sweep that removed something, else nothing. */
export const redisSweepMessage = ({
  namespaces,
  keys,
}: {
  readonly namespaces: readonly string[];
  readonly keys: number;
}): string | undefined =>
  keys === 0
    ? undefined
    : `test-integration: swept ${keys} stale test Redis keys in ${namespaces.length} namespaces left by earlier runs (ISSUE-237)`;

const LEAK_NAMES_SHOWN = 10;

/**
 * ISSUE-237: the lines for keys a run left with no expiry. A key that can
 * never expire is a leak by definition, so the run fails and names them.
 */
export const redisLeakMessages = (immortal: readonly string[]): string[] =>
  immortal.length === 0
    ? []
    : [
        `test-integration: ${immortal.length} test Redis keys had no expiry after the run and were removed (ISSUE-237); every test key must expire`,
        ...immortal
          .slice(0, LEAK_NAMES_SHOWN)
          .map((key) => `test-integration:   ${key}`),
        ...(immortal.length > LEAK_NAMES_SHOWN
          ? [
              `test-integration:   ...and ${immortal.length - LEAK_NAMES_SHOWN} more`,
            ]
          : []),
      ];

/** Runs `work` on a short-lived client (Bun blocks while the suites run, so none is held across them). */
async function withRedis<T>(
  url: string,
  work: (client: RedisClient) => Promise<T>,
): Promise<T> {
  const client = new RedisClient(url);
  try {
    return await work(client);
  } finally {
    client.close();
  }
}

/**
 * The suites to run and the arguments to hand `bun test`: every suite, or
 * only those the arguments name (by path, with or without `./`), so one file
 * can run through the runner and still get its own database.
 */
export function withSelectedSuites(
  suites: readonly string[],
  args: readonly string[],
): { readonly files: readonly string[]; readonly rest: readonly string[] } {
  const normalized = (arg: string) => arg.replace(/^\.\//, '');
  const named = args
    .filter((arg) => SUITE.test(normalized(arg)))
    .map(normalized);
  const missing = named.find((file) => !suites.includes(file));
  if (missing)
    throw new Error(
      `test-integration: ${missing} is not an integration suite of this workspace`,
    );
  return {
    files: named.length > 0 ? named : suites,
    rest: args.filter((arg) => !SUITE.test(normalized(arg))),
  };
}

/** The line for a sweep that dropped databases of dead runs, else nothing. */
export const sweepMessage = (dropped: readonly string[]): string | undefined =>
  dropped.length === 0
    ? undefined
    : `test-integration: dropped ${dropped.length} test databases left by runs that died (ISSUE-238): ${dropped.join(', ')}`;

/** Exact row counts of every public table in the test database. */
async function rowCounts(databaseUrl: string): Promise<RowCounts> {
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    const tables = (await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`) as Array<{
      table_name: string;
    }>;
    const counts: Record<string, number> = {};
    for (const { table_name: table } of tables) {
      const [row] = (await sql.unsafe(
        `SELECT count(*)::int AS rows FROM "${table}"`,
      )) as Array<{ rows: number }>;
      counts[table] = row?.rows ?? 0;
    }
    return counts;
  } finally {
    await sql.close();
  }
}

if (import.meta.main) {
  const suites = discoverSuites('.');
  if (suites.length === 0) {
    process.stderr.write('test-integration: no suites under integration/\n');
    process.exit(1);
  }
  const { files, rest } = withSelectedSuites(suites, process.argv.slice(2));
  const { databaseUrl, redisUrl } = requireTestSlotServices(process.env);
  // ISSUE-237: whatever a crashed, killed or timed-out run left in this
  // slot's test Redis database goes first, so no run pays for an earlier one.
  const sweptMessage = redisSweepMessage(
    await withRedis(redisUrl, (client) =>
      sweepIdleNamespaces(client, {
        prefix: TEST_NAMESPACE_PREFIX,
        idleMs: TEST_RUN_MAX_MS,
      }),
    ),
  );
  if (sweptMessage) process.stderr.write(`${sweptMessage}\n`);
  // ISSUE-238: the suites run against a database made for this run and
  // dropped after it, so nothing they write can outlive the run.
  const code = await withRunDatabase({
    slotDatabaseUrl: databaseUrl,
    maxRunMs: TEST_RUN_MAX_MS,
    root: `${import.meta.dir}/..`,
    onSweep: (dropped) => {
      const message = sweepMessage(dropped);
      if (message) process.stderr.write(`${message}\n`);
    },
    work: async (run) => {
      const before = await rowCounts(run.url);
      const suites = Bun.spawn(
        ['bun', 'test', ...files.map((file) => `./${file}`), ...rest],
        {
          stdio: ['inherit', 'inherit', 'inherit'],
          env: {
            ...process.env,
            TEST_DATABASE_URL: run.url,
            TEST_RUN_DATABASE: run.name,
          },
        },
      );
      const verdict = await superviseRun({
        exited: suites.exited,
        kill: () => suites.kill('SIGKILL'),
        lockLost: run.lockLost,
        maxRunMs: TEST_RUN_MAX_MS,
      });
      if (verdict === 'lost') {
        process.stderr.write(
          `test-integration: this run's Postgres connection was cut, so its liveness lock is gone and another run could drop ${run.name}; the suites were stopped (ISSUE-250). Run again.\n`,
        );
        return 1;
      }
      if (verdict === 'timeout') {
        process.stderr.write(
          `test-integration: the suites ran longer than the ${TEST_RUN_MAX_MS} ms run bound and were stopped (ISSUE-272).\n`,
        );
        return 1;
      }
      const leaks = redisLeakMessages(
        await withRedis(redisUrl, deleteAllKeysWithoutExpiry),
      );
      for (const line of leaks) process.stderr.write(`${line}\n`);
      const grown = grownTables(before, await rowCounts(run.url));
      for (const { table, before: from, after: to } of grown)
        process.stderr.write(
          `test-integration: ${table} grew from ${from} to ${to} rows; a suite left rows behind (ISSUE-192)\n`,
        );
      return (
        exitCodeOf({
          exitCode: suites.exitCode,
          signalCode: suites.signalCode,
        }) || (grown.length > 0 || leaks.length > 0 ? 1 : 0)
      );
    },
  });
  process.exit(code);
}
