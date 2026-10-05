import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const gateNames = [
  'check',
  'integration',
  'e2e',
  'migration-idempotency',
] as const;

export type VerifyGateName = (typeof gateNames)[number];
type VerifyStatus = 'pass' | 'fail' | 'skip';

export type VerifyGate = {
  readonly name: VerifyGateName;
  readonly status: VerifyStatus;
  readonly detail: string;
};

export type VerifyReport = {
  readonly ok: boolean;
  readonly gates: readonly VerifyGate[];
};

export type VerifyCommand = {
  readonly name: VerifyGateName;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
};

type StageResult = { readonly code: number; readonly output: string };

type VerifyOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Runs a stage; the default streams it into verify-logs/<logName>.log. */
  readonly run?: (
    command: VerifyCommand,
    logName: string,
  ) => Promise<StageResult>;
  /** Files this branch changes, for scoping browser e2e. */
  readonly changedFiles?: () => Promise<readonly string[]>;
  /** Stores one stage's full output; returns where it was kept. */
  readonly writeLog?: (stage: string, output: string) => string;
  readonly print?: (text: string) => void;
  /** Archives a failed browser run's artifacts; returns where, if anything. */
  readonly keepE2eArtifacts?: () => string | undefined;
};

const TAIL_LINES = 40;
const LOG_DIR = 'verify-logs';
const E2E_RESULTS = join('apps', 'web', 'test-results');
const E2E_ARCHIVE_DIR = join(LOG_DIR, 'e2e-failures');

/**
 * A failed browser run's archive name: its UTC start to the second, then the
 * commit. Playwright empties test-results at the start of every run, so the
 * only copy that outlives the next run is one under a name no run reuses.
 */
export function e2eArchiveName(now: Date, sha: string): string {
  return `${now.toISOString().slice(0, 19).replaceAll(':', '-')}Z-${sha}`;
}

/**
 * Copies the whole results folder: with retain-on-failure it holds only the
 * failed tests' traces, screenshots and videos, plus the server logs.
 */
export function archiveE2eArtifacts({
  from,
  to,
}: {
  readonly from: string;
  readonly to: string;
}): boolean {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  return true;
}

function keepE2eResults(): string | undefined {
  const sha = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
    cwd: root,
  })
    .stdout.toString()
    .trim();
  const to = join(
    root,
    E2E_ARCHIVE_DIR,
    e2eArchiveName(new Date(), sha || 'unknown'),
  );
  return archiveE2eArtifacts({ from: join(root, E2E_RESULTS), to })
    ? relative(root, to)
    : undefined;
}

/**
 * A diff that touches only documentation: Markdown under docs/, ADRs
 * included. AGENTS.md, skills and other Markdown instruct agents or ship
 * with the app, and data files under docs/ feed gates, so they count as code.
 */
export function isDocsOnly(files: readonly string[]): boolean {
  return (
    files.length > 0 &&
    files.every((file) => file.startsWith('docs/') && file.endsWith('.md'))
  );
}

/**
 * Every file a branch changes: committed, in the working tree, and
 * untracked. Undefined means a git command failed; with no base to compare
 * against, the diff is assumed to touch code.
 */
export function combineChanges(
  ...lists: readonly (readonly string[] | undefined)[]
): readonly string[] {
  return lists.every((list) => list !== undefined)
    ? [...new Set(lists.flat() as string[])]
    : [];
}

const pass = (name: VerifyGateName, detail: string): VerifyGate => ({
  name,
  status: 'pass',
  detail,
});

const fail = (name: VerifyGateName, detail: string): VerifyGate => ({
  name,
  status: 'fail',
  detail,
});

export function createVerifyReport(gates: readonly VerifyGate[]): VerifyReport {
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const orderedGates = gateNames.map(
    (name): VerifyGate =>
      byName.get(name) ?? { name, status: 'fail', detail: 'not checked' },
  );
  return {
    ok: orderedGates.every((gate) => gate.status !== 'fail'),
    gates: orderedGates,
  };
}

export function formatVerifyReport(
  report: VerifyReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Offense Demo verify: ${report.ok ? 'PASS' : 'FAIL'}`,
    ...report.gates.map(
      (gate) => `${gate.status.toUpperCase()} ${gate.name}: ${gate.detail}`,
    ),
    '',
  ].join('\n');
}

function createEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  databaseUrl?: string,
): Readonly<Record<string, string>> | undefined {
  const values = Object.entries({
    ...environment,
    ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
  })
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .reduce<Record<string, string>>(
      (result, [key, value]) => ({ ...result, [key]: value }),
      {},
    );
  return Object.keys(values).length > 0 ? values : undefined;
}

function isTestDatabaseUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).pathname.endsWith('_test');
  } catch {
    return false;
  }
}

/**
 * Runs a stage with stdout and stderr both written straight to its log
 * file, so the log interleaves them as written and survives a killed run.
 */
export async function runLogged(
  argv: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly logPath: string;
  },
): Promise<StageResult> {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const fd = openSync(options.logPath, 'w');
  try {
    const child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      stdout: fd,
      stderr: fd,
    });
    const code = await child.exited;
    return { code, output: readFileSync(options.logPath, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

const logPathOf = (stage: string): string =>
  join(root, LOG_DIR, `${stage}.log`);

function runProcess(
  command: VerifyCommand,
  environment: Readonly<Record<string, string | undefined>>,
  logName: string,
): Promise<StageResult> {
  return runLogged(['bun', ...command.args], {
    cwd: root,
    env: createEnvironment(environment, command.env?.DATABASE_URL),
    logPath: logPathOf(logName),
  });
}

function writeStageLog(stage: string, output: string): string {
  const path = logPathOf(stage);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output);
  return relative(root, path);
}

/** Every file the branch in cwd changes against base (see combineChanges). */
export async function gitChangedFiles(
  cwd: string = root,
  base = 'origin/main',
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly string[]> {
  // Git hooks export GIT_DIR and friends; the repository is cwd's, not theirs.
  const env = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
  );
  const lines = async (args: readonly string[]) => {
    const child = Bun.spawn(['git', ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(child.stdout).text();
    return (await child.exited) === 0
      ? text.split('\n').filter(Boolean)
      : undefined;
  };
  return combineChanges(
    // --no-renames lists a rename's old path too: moving code under docs/
    // is still a code change.
    await lines(['diff', '--name-only', '--no-renames', `${base}...HEAD`]),
    await lines(['diff', '--name-only', '--no-renames', 'HEAD']),
    await lines(['ls-files', '--others', '--exclude-standard']),
  );
}

type Stage = {
  readonly run: (
    command: VerifyCommand,
    logName: string,
  ) => Promise<StageResult>;
  readonly writeLog: (stage: string, output: string) => string;
  readonly print: (text: string) => void;
};

async function runCommand(
  command: VerifyCommand,
  stage: Stage,
  logName: string = command.name,
): Promise<string> {
  let result: StageResult;
  try {
    result = await stage.run(command, logName);
  } catch (error) {
    result = { code: -1, output: String(error) };
  }
  const log = stage.writeLog(logName, result.output);
  if (result.code === 0) return 'completed';
  const tail = result.output.split('\n').slice(-TAIL_LINES).join('\n');
  stage.print(
    `--- ${logName} failed (exit ${result.code}); last ${TAIL_LINES} lines, full log ${log}\n${tail}\n`,
  );
  return `exit ${result.code}; log ${log}`;
}

async function migrationGate(
  testDatabaseUrl: string | undefined,
  stage: Stage,
): Promise<VerifyGate> {
  if (!isTestDatabaseUrl(testDatabaseUrl))
    return fail('migration-idempotency', 'TEST_DATABASE_URL unavailable');
  const command = {
    name: 'migration-idempotency' as const,
    args: ['run', 'db:migrate'],
    env: { DATABASE_URL: testDatabaseUrl },
  };
  const first = await runCommand(command, stage, `${command.name}-1`);
  if (first !== 'completed')
    return fail('migration-idempotency', `first migration: ${first}`);
  const second = await runCommand(command, stage, `${command.name}-2`);
  return second === 'completed'
    ? pass('migration-idempotency', 'completed twice')
    : fail('migration-idempotency', `second migration: ${second}`);
}

/** A failed browser run keeps its artifacts where the next run cannot reach. */
const withArtifacts = (
  detail: string,
  keep: () => string | undefined,
): string => {
  if (detail === 'completed') return detail;
  const kept = keep();
  return kept ? `${detail}; artifacts ${kept}` : detail;
};

const gate = (name: VerifyGateName, detail: string): VerifyGate =>
  detail === 'completed' ? pass(name, detail) : fail(name, detail);

export async function runVerify({
  environment = process.env,
  run = (command, logName) => runProcess(command, environment, logName),
  changedFiles = () => gitChangedFiles(),
  writeLog = writeStageLog,
  print = (text) => void process.stderr.write(text),
  keepE2eArtifacts = keepE2eResults,
}: VerifyOptions = {}): Promise<VerifyReport> {
  const stage: Stage = { run, writeLog, print };
  const check = await runCommand(
    { name: 'check', args: ['run', 'check'] },
    stage,
  );
  const integration = await runCommand(
    { name: 'integration', args: ['run', 'test:integration'] },
    stage,
  );
  const files = await changedFiles();
  const e2e = isDocsOnly(files)
    ? {
        name: 'e2e' as const,
        status: 'skip' as const,
        detail: `skipped: documentation-only diff (${files.length} file${files.length === 1 ? '' : 's'})`,
      }
    : gate(
        'e2e',
        withArtifacts(
          await runCommand({ name: 'e2e', args: ['run', 'test:e2e'] }, stage),
          keepE2eArtifacts,
        ),
      );
  return createVerifyReport([
    gate('check', check),
    gate('integration', integration),
    e2e,
    await migrationGate(environment.TEST_DATABASE_URL, stage),
  ]);
}

if (import.meta.main) {
  const report = await runVerify();
  process.stdout.write(
    formatVerifyReport(report, process.argv.includes('--json')),
  );
  process.exitCode = report.ok ? 0 : 1;
}
