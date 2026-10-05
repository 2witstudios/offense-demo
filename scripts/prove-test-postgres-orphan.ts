#!/usr/bin/env bun
/**
 * ISSUE-260 proof, run by `bun proof:test-postgres` after the SIGKILL proof:
 * a runner is SIGKILLed while its suite keeps running, so its sessions stay
 * open and idle for good (a hung orphan). The run database is kept while the
 * suite could still be live, and dropped, sessions terminated, once its
 * sessions are older than the run bound. A live run side by side is never
 * dropped, however old its sessions, because its runner holds the lock.
 *
 * Both runs are the hold suite (`startHeldRun`): it waits for a release file,
 * so nothing here depends on how long a real suite takes or on the clock
 * (ISSUE-270); every control prints what it observed when it fails.
 */
import { sweepTestRunDatabases } from '@offense-demo/db/test-runs';
import {
  admin,
  awaitLockFree,
  awaitSessionsOlderThan,
  cleanUpProof,
  runDatabases,
  sessionsOn,
  slotDatabase,
  startHeldRun,
} from './proof-postgres-support';
import { proofSteps } from './proof-support';

const HOUR_MS = 3_600_000;
// A stand-in for the run bound, small enough to wait out here.
const BOUND_MS = 3_000;
const { check, finish } = proofSteps();
const sweep = (maxRunMs: number) =>
  sweepTestRunDatabases(admin, slotDatabase, { maxRunMs });

async function main() {
  // The hung orphan: its runner is killed, its suite carries on, sessions open.
  const hung = await startHeldRun();
  process.kill(hung.proc.pid, 'SIGKILL');
  await hung.proc.exited;
  await awaitLockFree(hung.database);
  const orphanSessions = await sessionsOn(hung.database);
  check(
    orphanSessions > 0,
    `ISSUE-260: the runner is dead (lock free) but its suite still holds sessions on ${hung.database}`,
    { orphanSessions },
  );

  // A live run beside it: its runner is alive and holds its lock.
  const live = await startHeldRun();
  const afterLiveStart = await runDatabases();
  check(
    afterLiveStart.includes(hung.database),
    'ISSUE-260: the live run’s own sweep (bound: the run length, one hour) left the orphan alone while its sessions are young',
    { hung: hung.database, live: live.database, runDatabases: afterLiveStart },
  );
  const withHourBound = await sweep(HOUR_MS);
  check(
    withHourBound.length === 0,
    'ISSUE-260 control: a sweep with the real one-hour bound keeps the orphan, whose sessions are seconds old',
    { dropped: withHourBound },
  );

  // Past the bound, on the real condition (Postgres reports every session of
  // the orphan older than the bound), not a sleep.
  await awaitSessionsOlderThan(hung.database, BOUND_MS);
  const dropped = await sweep(BOUND_MS);
  const remaining = await runDatabases();
  check(
    dropped.length === 1 &&
      dropped[0] === hung.database &&
      !remaining.includes(hung.database),
    `ISSUE-260: once its sessions are older than the bound, the sweep terminates them and drops ${hung.database}`,
    { dropped, remaining, hung: hung.database },
  );
  check(
    remaining.includes(live.database) && !dropped.includes(live.database),
    `ISSUE-260: the live run’s ${live.database}, whose sessions are just as old, was never dropped: its runner holds the lock`,
    { dropped, remaining, live: live.database },
  );

  // Release the live run: it carried on beside the sweep and passes.
  live.release();
  const liveExit = await live.proc.exited;
  const liveLog = await live.log;
  check(
    liveExit === 0 && !liveLog.includes('lock is gone'),
    'ISSUE-260: the live run carried on beside the sweep and passed',
    { exit: liveExit, log: liveLog.slice(-600) },
  );
  const left = await runDatabases();
  check(left.length === 0, 'ISSUE-260: no run database of the slot is left', {
    left,
  });
}

try {
  await main();
} finally {
  await cleanUpProof();
}
finish();
