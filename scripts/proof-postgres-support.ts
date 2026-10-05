/**
 * What the hand-run Postgres proofs share (`bun proof:test-postgres`): the
 * slot's server, the REAL runner over real suites, and the run databases the
 * runner leaves or holds, read straight from Postgres.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { SQL } from 'bun';
import { requireTestSlotServices } from '@offense-demo/config';
import { dropAllTestRunDatabases } from '@offense-demo/db/test-runs';

export const root = `${import.meta.dir}/..`;
export const web = `${root}/apps/web`;
const { databaseUrl } = requireTestSlotServices(process.env);
export const slotDatabase = new URL(databaseUrl).pathname.slice(1);
export const urlOf = (database: string) => {
  const next = new URL(databaseUrl);
  next.pathname = `/${database}`;
  return next.toString();
};
export const admin = new SQL(urlOf('postgres'), { max: 1 });

export const SLOW = 'integration/auth-rate-limit-mail-ceilings.integration.ts';
export const FAST = 'integration/composition-root.integration.ts';
// Every process a proof starts or stops, killed however the proof ends (a
// stopped suite is never left behind, ISSUE-273). Each is remembered with the
// start time the OS reports, so cleanup never signals a pid that exited and
// was reused by an unrelated process (ISSUE-271).
const startTimeOf = (pid: number): string =>
  Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
    .stdout.toString()
    .trim();
const tracked: Array<{ readonly pid: number; readonly startedAt: string }> = [];
const track = (pid: number): number => {
  tracked.push({ pid, startedAt: startTimeOf(pid) });
  return pid;
};
const runnerCommand = (suite: string) => [
  'bun',
  `--env-file=${root}/.env`,
  `${root}/scripts/test-integration.ts`,
  suite,
];
export const runner = (suite: string) => {
  const proc = Bun.spawn(runnerCommand(suite), {
    cwd: web,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  track(proc.pid);
  return proc;
};
export const textOf = async (stream: ReadableStream<Uint8Array>) =>
  await new Response(stream).text();

export async function runDatabases(): Promise<string[]> {
  const rows = (await admin`
    select datname as name from pg_database
    where starts_with(datname, ${`${slotDatabase}_run_`}) order by datname`) as Array<{
    name: string;
  }>;
  return rows.map(({ name }) => name);
}

export async function rowsIn(database: string, table: string): Promise<number> {
  const sql = new SQL(urlOf(database), { max: 1 });
  try {
    const [row] = (await sql.unsafe(
      `select count(*)::int as rows from "${table}"`,
    )) as Array<{ rows: number }>;
    return row?.rows ?? 0;
  } finally {
    await sql.close();
  }
}

export async function tableCounts(
  database: string,
): Promise<Record<string, number>> {
  const sql = new SQL(urlOf(database), { max: 1 });
  try {
    const tables = (await sql`select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`) as Array<{ table_name: string }>;
    const counts: Record<string, number> = {};
    for (const { table_name: table } of tables) {
      const [row] = (await sql.unsafe(
        `select count(*)::int as rows from "${table}"`,
      )) as Array<{ rows: number }>;
      counts[table] = row?.rows ?? 0;
    }
    return counts;
  } finally {
    await sql.close();
  }
}

/**
 * Waits for a run database of the slot that is not in `known` and holds rows.
 * There is no clock: it waits for the rows, however slow the machine, and
 * fails the moment `run` (the runner just started) exits without them
 * (ISSUE-261).
 */
export async function waitForBusyRun(
  known: readonly string[],
  run: { readonly exited: Promise<number>; readonly exitCode: number | null },
): Promise<string> {
  let ended = false;
  void run.exited.then(() => (ended = true));
  while (!ended) {
    for (const name of await runDatabases())
      if (!known.includes(name)) {
        try {
          if ((await rowsIn(name, 'verification')) > 0) return name;
        } catch {
          // still migrating
        }
      }
    await Bun.sleep(250);
  }
  throw new Error(
    `the suite run ended (exit ${run.exitCode}) before it wrote a row`,
  );
}

export const descendants = (pid: number): number[] => {
  const out = Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString();
  return out
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .flatMap((child) => [child, ...descendants(child)]);
};

/** Whether `database` has no session besides ours. */
const sessionsOn = async (database: string): Promise<number> =>
  (
    (await admin.unsafe(
      `select count(*)::int as sessions from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()`,
    )) as Array<{ sessions: number }>
  )[0]?.sessions ?? 0;
export { sessionsOn };

/** Waits until the dead runner's liveness lock is free (its sessions may remain). */
export async function awaitLockFree(database: string): Promise<void> {
  const key = `hashtextextended('${database}', 0)`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const [{ free }] = (await admin.unsafe(
      `select pg_try_advisory_lock(${key}) as free`,
    )) as [{ free: boolean }];
    if (free) {
      await admin.unsafe(`select pg_advisory_unlock(${key})`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`${database} is still locked`);
    await Bun.sleep(100);
  }
}

/**
 * Waits, on the real condition, until a killed run's database has no session
 * left and its runner's liveness lock is free: Postgres notices a dead client
 * a moment after the process is gone, longer on a loaded machine. The next
 * run's sweep must start after that, or it rightly skips a database that
 * still looks live (ISSUE-261). Fails, never proceeds, if it does not happen.
 */
export async function awaitRunEnded(database: string): Promise<void> {
  const key = `hashtextextended('${database}', 0)`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const sessions = await sessionsOn(database);
    const [{ free }] = (await admin.unsafe(
      `select pg_try_advisory_lock(${key}) as free`,
    )) as [{ free: boolean }];
    if (free) await admin.unsafe(`select pg_advisory_unlock(${key})`);
    if (sessions === 0 && free) return;
    if (Date.now() > deadline)
      throw new Error(`${database} still has sessions or a held lock`);
    await Bun.sleep(100);
  }
}

/** Waits until every session on `database` started at least `ms` ago (and there is one): the real condition behind "older than the bound", read from Postgres, not a sleep. */
export async function awaitSessionsOlderThan(
  database: string,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const [row] = (await admin.unsafe(
      `select count(*)::int as total,
         (count(*) filter (where backend_start >= now() - ${Number(ms)} * interval '1 millisecond'))::int as young
       from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()`,
    )) as Array<{ total: number; young: number }>;
    if ((row?.total ?? 0) > 0 && row?.young === 0) return;
    if (Date.now() > deadline)
      throw new Error(`the sessions on ${database} never aged past ${ms} ms`);
    await Bun.sleep(100);
  }
}

/**
 * Ends a proof however it ended (ISSUE-273): kills every process it started
 * or stopped, with their descendants, drops the run databases it left (the
 * proofs own the slot while they run), and closes the admin connection.
 */
export async function cleanUpProof(): Promise<void> {
  for (const { pid, startedAt } of tracked) {
    // Only the process the proof started: a reused pid has another start time.
    if (startedAt === '' || startTimeOf(pid) !== startedAt) continue;
    for (const target of [...descendants(pid), pid])
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // already gone
      }
  }
  rmSync(holdDirectory, { recursive: true, force: true });
  await dropAllTestRunDatabases(admin, slotDatabase);
  await admin.close();
}

const holdDirectory = `${web}/.proof-hold`;
const holdSuite = `import { existsSync, writeFileSync } from 'node:fs';
import { setDefaultTimeout, test } from 'bun:test';
import { SQL } from 'bun';
import { requireTestServices } from '@offense-demo/config';

// A suite that only holds its run database open: it connects, says which
// database it is on, and waits for a release file (ISSUE-270). Nothing in it
// depends on the clock, so a proof can hold a live run, or leave an orphan,
// for exactly as long as it needs.
setDefaultTimeout(1_800_000);
const { databaseUrl } = requireTestServices(process.env);
const base = process.env.PROOF_HOLD_FILE ?? '';
test('holds its run database until released', async () => {
  const sql = new SQL(databaseUrl, { max: 1 });
  await sql\`select 1\`;
  writeFileSync(\`\${base}.ready\`, process.env.TEST_RUN_DATABASE ?? '');
  while (!existsSync(\`\${base}.release\`)) await Bun.sleep(50);
  await sql.close();
}, 1_800_000);
`;

/**
 * A REAL runner over the hold suite: a live run (or, once its runner is
 * killed, a hung orphan) that stays exactly as long as the proof wants. It
 * resolves once the suite is connected and has named its run database.
 */
export async function startHeldRun() {
  mkdirSync(`${holdDirectory}/integration`, { recursive: true });
  writeFileSync(`${holdDirectory}/integration/hold.integration.ts`, holdSuite);
  const base = `${tmpdir()}/proof-hold-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
  const proc = Bun.spawn(runnerCommand('integration/hold.integration.ts'), {
    cwd: holdDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROOF_HOLD_FILE: base },
  });
  track(proc.pid);
  const log = textOf(proc.stderr);
  let ended = false;
  void proc.exited.then(() => (ended = true));
  while (!existsSync(`${base}.ready`)) {
    if (ended)
      throw new Error(
        `the held run ended (exit ${proc.exitCode}) before it was ready: ${(await log).slice(-500)}`,
      );
    await Bun.sleep(50);
  }
  return {
    proc,
    log,
    database: readFileSync(`${base}.ready`, 'utf8'),
    suites: descendants(proc.pid).map(track),
    release: () => writeFileSync(`${base}.release`, ''),
  };
}
