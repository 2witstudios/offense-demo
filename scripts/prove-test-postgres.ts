#!/usr/bin/env bun
/**
 * ISSUE-238 proof, run by hand against this checkout's own slot
 * (`bun proof:test-postgres`; needs `bun slot:up`). It drives the REAL runner
 * over real suites:
 *
 *   1. A run is SIGKILLed mid-suite (runner and suite process both). Its
 *      rows are in its own run database, never in the slot's `_test`
 *      database, and the database is left behind.
 *   2. The next clean run's sweep drops it, the run passes, the row ledger
 *      is flat, and no run database of the slot remains.
 *   3. Negative controls: a run that is alive is never swept by a concurrent
 *      run (and finishes cleanly); a suite started by hand against the slot
 *      database is refused; before the sweep the killed run's database is
 *      still there (the mechanism, not luck, removes it).
 *   4. ISSUE-250: the runner's lock session is killed mid-run
 *      (`pg_terminate_backend`). The run stops loudly, and no sweep drops the
 *      database while its suites are still executing.
 *   5. ISSUE-249: rows planted in another run's database and in another
 *      slot's run database survive a suite started by hand against them,
 *      which is refused.
 */
import { SQL } from 'bun';
import {
  claimTestRunDatabase,
  dropTestRunDatabase,
  sweepTestRunDatabases,
  testRunDatabaseName,
} from '@offense-demo/db/test-runs';

import { proofSteps } from './proof-support';
import {
  admin,
  awaitRunEnded,
  cleanUpProof,
  descendants,
  FAST,
  root,
  rowsIn,
  runDatabases,
  runner,
  sessionsOn,
  SLOW,
  startHeldRun,
  slotDatabase,
  tableCounts,
  textOf,
  urlOf,
  waitForBusyRun,
  web,
} from './proof-postgres-support';

// The runner's bound (TEST_RUN_MAX_MS): a session younger than this may be a live run's.
const RUN_MAX_MS = 3_600_000;
const { check, finish } = proofSteps();

/** Kills the runner's lock session mid-run; sweeps meanwhile must not drop the database. */
async function proveLockLoss() {
  const victim = await startHeldRun();
  const [holder] = (await admin.unsafe(
    `select pid from pg_locks where locktype = 'advisory' and granted
     and ((classid::bigint << 32) | objid::bigint) = hashtextextended('${victim.database}', 0)`,
  )) as Array<{ pid: number }>;
  if (!holder) throw new Error('the run holds no liveness lock');
  await admin.unsafe(`select pg_terminate_backend(${holder.pid})`);
  // Hold the runner (the supervisor) still while its suite keeps executing,
  // so the sweep below runs during the window the lost lock opens, however
  // loaded the machine is; then let it notice and stop the run. The suite is
  // the hold suite, so it is still connected however long the sweep takes.
  process.kill(victim.proc.pid, 'SIGSTOP');
  const sessionsBefore = await sessionsOn(victim.database);
  const dropped = await sweepTestRunDatabases(admin, slotDatabase, {
    maxRunMs: RUN_MAX_MS,
  });
  const sessionsAfter = await sessionsOn(victim.database);
  process.kill(victim.proc.pid, 'SIGCONT');
  const exit = await victim.proc.exited;
  const log = await victim.log;
  const left = await runDatabases();
  check(
    sessionsBefore > 0 &&
      sessionsAfter > 0 &&
      !dropped.includes(victim.database),
    `ISSUE-250: a sweep ran while the suite was connected with its runner's lock session killed, and did not drop ${victim.database}`,
    { sessionsBefore, sessionsAfter, dropped },
  );
  check(
    exit !== 0 && log.includes('liveness lock is gone'),
    'ISSUE-250: the run whose lock session was killed stopped loudly (non-zero exit, named error) instead of continuing unlocked',
    { exit, log: log.slice(-600) },
  );
  check(
    !left.includes(victim.database),
    'ISSUE-250: the stopped run dropped its own database, so nothing is left behind',
    { left },
  );
}

/** Rows planted in other databases survive a suite started by hand against them. */
async function provePlantedRows() {
  const another = testRunDatabaseName(slotDatabase, 'a0a0a0a0');
  const otherSlot = testRunDatabaseName(
    'offense_demo_wt_zzzzzzzz_test',
    'b1b1b1b1',
  );
  const planted = new SQL(urlOf('postgres'), { max: 1 });
  try {
    for (const name of [another, otherSlot]) {
      await claimTestRunDatabase(planted, name);
      const db = new SQL(urlOf(name), { max: 1 });
      await db.unsafe('create table planted (id int)');
      await db.unsafe('insert into planted values (1)');
      await db.close();
    }
    const byHand = async (name: string, runDatabase: string | undefined) => {
      const proc = Bun.spawn(
        ['bun', `--env-file=${root}/.env`, 'test', `./${FAST}`],
        {
          cwd: web,
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            ...process.env,
            TEST_DATABASE_URL: urlOf(name),
            ...(runDatabase ? { TEST_RUN_DATABASE: runDatabase } : {}),
          },
        },
      );
      const log = await textOf(proc.stderr);
      await proc.exited;
      return { exit: proc.exitCode, log };
    };
    const results = [
      await byHand(another, undefined),
      await byHand(another, 'offense_demo_other_run'),
      await byHand(otherSlot, otherSlot),
    ];
    const rows = await Promise.all(
      [another, otherSlot].map((name) => rowsIn(name, 'planted')),
    );
    check(
      results.every(({ exit }) => exit !== 0) &&
        results[0]?.log.includes("run's own database") === true &&
        results[1]?.log.includes("run's own database") === true &&
        results[2]?.log.includes('database of this slot') === true,
      'ISSUE-249: a suite started by hand against another run of this slot (URL alone, or with a wrong run name) and against another slot’s run database is refused at import',
      results.map(({ exit, log }) => ({ exit, log: log.slice(-300) })),
    );
    check(
      rows.every((count) => count === 1),
      'ISSUE-249: the row planted in each of those databases survived',
      { rows },
    );
  } finally {
    for (const name of [another, otherSlot])
      await dropTestRunDatabase(planted, name);
    await planted.close();
  }
}

async function main() {
  const start = await runDatabases();
  check(
    start.length === 0,
    `no run database of ${slotDatabase} to begin with`,
    { start },
  );
  const baseBefore = await tableCounts(slotDatabase);

  // 1. Kill a real run mid-suite.
  const doomed = runner(SLOW);
  const doomedDatabase = await waitForBusyRun(start, doomed);
  const leaked = await rowsIn(doomedDatabase, 'verification');
  for (const pid of [...descendants(doomed.pid), doomed.pid])
    process.kill(pid, 'SIGKILL');
  await doomed.exited;
  // ISSUE-261: the next run starts only once Postgres has ended the dead run's sessions.
  await awaitRunEnded(doomedDatabase);
  const baseAfterKill = await tableCounts(slotDatabase);
  check(
    JSON.stringify(baseAfterKill) === JSON.stringify(baseBefore),
    `AC: the ${leaked} verification rows of the SIGKILLed run are in ${doomedDatabase}, not in ${slotDatabase} (its counts are unchanged)`,
  );
  check(
    (await runDatabases()).includes(doomedDatabase),
    'AC control: before the next run the killed run’s database is still there (only the sweep removes it)',
  );

  // 3a. A run that is alive is never swept by a concurrent run. The live run
  // is the hold suite, so it is still running however long the concurrent
  // run takes (ISSUE-270).
  const alive = await startHeldRun();
  const concurrent = runner(FAST);
  const concurrentLog = await textOf(concurrent.stderr);
  const concurrentExit = await concurrent.exited;
  const stillThere = await runDatabases();
  check(
    concurrentExit === 0 &&
      stillThere.includes(alive.database) &&
      !concurrentLog.includes('dropped') &&
      !stillThere.includes(doomedDatabase),
    'AC control: a concurrent run never drops the live run’s database',
    {
      concurrentExit,
      alive: alive.database,
      doomed: doomedDatabase,
      runDatabases: stillThere,
      concurrentLog: concurrentLog.slice(-500),
    },
  );
  alive.release();
  const aliveExit = await alive.proc.exited;
  const aliveLog = await alive.log;
  check(
    aliveExit === 0 && aliveLog.includes(doomedDatabase),
    'AC control: the live run swept the dead run’s database at its start, was unaffected by the concurrent run, and passed',
    { aliveExit, doomed: doomedDatabase, log: aliveLog.slice(-600) },
  );

  // 2. The next clean run: sweep, pass, ledger flat, nothing left.
  const orphan = await (async () => {
    const victim = runner(SLOW);
    const name = await waitForBusyRun([], victim);
    for (const pid of [...descendants(victim.pid), victim.pid])
      process.kill(pid, 'SIGKILL');
    await victim.exited;
    await awaitRunEnded(name);
    return name;
  })();
  const clean = runner(FAST);
  const cleanLog = await textOf(clean.stderr);
  await clean.exited;
  check(
    clean.exitCode === 0 &&
      cleanLog.includes(orphan) &&
      !cleanLog.includes('grew from'),
    'AC: the next run sweeps the killed run’s database, passes, and its row ledger is flat',
    { exit: clean.exitCode, orphan, log: cleanLog.slice(-600) },
  );
  check(
    (await runDatabases()).length === 0,
    `AC: no run database of ${slotDatabase} survives the clean run`,
  );
  check(
    JSON.stringify(await tableCounts(slotDatabase)) ===
      JSON.stringify(baseBefore),
    `AC: ${slotDatabase} holds exactly the rows it held before any of this`,
  );

  // 3b. A suite started by hand is refused.
  const byHand = Bun.spawn(
    ['bun', `--env-file=${root}/.env`, 'test', `./${FAST}`],
    { cwd: web, stdout: 'pipe', stderr: 'pipe' },
  );
  const handLog = await textOf(byHand.stderr);
  await byHand.exited;
  check(
    byHand.exitCode !== 0 && handLog.includes("must name this run's database"),
    'AC control: a suite run by hand against the slot database is refused, so it cannot leak rows',
    { exit: byHand.exitCode, log: handLog.slice(-400) },
  );

  await proveLockLoss();
  await provePlantedRows();
}

try {
  await main();
} finally {
  await cleanUpProof();
}
finish();
