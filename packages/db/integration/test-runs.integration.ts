import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import {
  claimTestRunDatabase,
  dropAllTestRunDatabases,
  sweepTestRunDatabases,
  testRunDatabaseName,
  testRunToken,
} from '../src/test-runs';

setupRitewayBun();
const { databaseUrl } = requireTestServices(process.env);

// A base outside `offense_demo_wt_*` and unique per file: slot pruning and other
// runs' sweeps can never select these databases, and these tests never touch
// another slot's.
const base = `offense_demo_probe_${createId().slice(0, 12)}_test`;
const connect = (database: string) => {
  const next = new URL(databaseUrl);
  next.pathname = `/${database}`;
  return new SQL(next.toString(), { max: 1 });
};
// CREATE/DROP DATABASE copy and remove files; under a machine full of
// parallel suites a handful of them can exceed bun's 5 s per-test default.
const ddlTimeoutMs = 30_000;
// A run may last an hour: no session in these tests is that old.
const RUN_BOUND = { maxRunMs: 3_600_000 };
const randomToken = () =>
  testRunToken(crypto.getRandomValues(new Uint8Array(4)));

const exists = async (admin: SQL, name: string) =>
  ((await admin`select 1 from pg_database where datname = ${name}`).length ??
    0) > 0;

/**
 * Sweeps until `name` is dropped: Postgres frees a dead connection's lock
 * when its backend exits, a moment after the client closes, so the first
 * sweep can still see the runner as alive. Waits for that, not for a time.
 */
async function sweepUntilDropped(
  sweeper: SQL,
  name: string,
  bound = RUN_BOUND,
) {
  const dropped: string[] = [];
  const deadline = Date.now() + 5_000;
  do {
    dropped.push(...(await sweepTestRunDatabases(sweeper, base, bound)));
  } while (!dropped.includes(name) && Date.now() < deadline);
  return dropped;
}

/** A runner's life in miniature: its own admin connection, its run database claimed. */
async function startRun(baseName = base) {
  const runner = connect('postgres');
  const name = testRunDatabaseName(baseName, randomToken());
  await claimTestRunDatabase(runner, name);
  return { runner, name };
}

test(
  'ISSUE-238: a sweep drops the database of a run whose runner died, and only that',
  async () => {
    const sweeper = connect('postgres');
    const live = await startRun();
    const dead = await startRun();
    const otherSlot = await startRun(`${base.replace(/_test$/, '')}_x_test`);
    try {
      // The dead run: its runner is killed, so its connection (and lock) go.
      await dead.runner.close();
      await otherSlot.runner.close();

      const dropped = await sweepUntilDropped(sweeper, dead.name);

      assert({
        given:
          'one live run, one whose runner died, and a dead run of another slot',
        should:
          'drop the dead run only: the live run holds its lock (negative control) and another slot is not this slot’s to sweep',
        actual: {
          dropped,
          live: await exists(sweeper, live.name),
          dead: await exists(sweeper, dead.name),
          otherSlot: await exists(sweeper, otherSlot.name),
        },
        expected: {
          dropped: [dead.name],
          live: true,
          dead: false,
          otherSlot: true,
        },
      });
    } finally {
      await dropAllTestRunDatabases(sweeper, base);
      await dropAllTestRunDatabases(
        sweeper,
        `${base.replace(/_test$/, '')}_x_test`,
      );
      await live.runner.close();
      await sweeper.close();
    }
  },
  ddlTimeoutMs,
);

test(
  'ISSUE-238: rows written to a killed run’s database vanish with it',
  async () => {
    const sweeper = connect('postgres');
    const run = await startRun();
    try {
      const inRun = connect(run.name);
      await inRun`create table leaked (id int)`;
      await inRun`insert into leaked select generate_series(1, 730)`;
      // The suites' own connection is still open when the runner is killed.
      await run.runner.close();
      // Wait until Postgres has freed the dead runner's lock, so that only
      // the open suite connection can be what keeps the database.
      const key = `hashtextextended('${run.name}', 0)`;
      const deadline = Date.now() + 5_000;
      for (;;) {
        const [{ free }] = (await sweeper.unsafe(
          `select pg_try_advisory_lock(${key}) as free`,
        )) as [{ free: boolean }];
        if (free) await sweeper.unsafe(`select pg_advisory_unlock(${key})`);
        if (free || Date.now() > deadline) break;
        await Bun.sleep(25);
      }
      const whileConnected = await sweepTestRunDatabases(
        sweeper,
        base,
        RUN_BOUND,
      );
      const keptWhileConnected = await exists(sweeper, run.name);
      await inRun.close();

      const dropped = await sweepUntilDropped(sweeper, run.name);

      assert({
        given:
          'a database holding 730 rows and a suite connection still open, its runner killed (lock free)',
        should:
          'be kept while the suite is connected (a live run that lost its lock is never dropped under it), then dropped with its rows once the connection ends',
        actual: {
          whileConnected,
          keptWhileConnected,
          dropped,
          left: await exists(sweeper, run.name),
        },
        expected: {
          whileConnected: [],
          keptWhileConnected: true,
          dropped: [run.name],
          left: false,
        },
      });
    } finally {
      await dropAllTestRunDatabases(sweeper, base);
      await sweeper.close();
    }
  },
  ddlTimeoutMs,
);

test(
  'ISSUE-238: a claim never waits on or shares another run’s database',
  async () => {
    const admin = connect('postgres');
    const run = await startRun();
    try {
      const outcomes = [
        await claimTestRunDatabase(admin, run.name).then(
          () => 'claimed',
          (error: Error) => error.message,
        ),
      ];
      // Its runner gone, the name is free but the database is still there.
      await run.runner.close();
      // Postgres frees a dead connection's lock when its backend exits,
      // a moment after the client closes: wait for that, not for a time.
      const deadline = Date.now() + 5_000;
      let second = 'claimed';
      do {
        second = await claimTestRunDatabase(admin, run.name).then(
          () => 'claimed',
          (error: Error & { errno?: string }) => error.errno ?? error.message,
        );
      } while (second.endsWith('is already claimed') && Date.now() < deadline);
      outcomes.push(second);

      assert({
        given: 'a run database whose name is claimed, then one that exists',
        should:
          'refuse without waiting while its runner lives, and with Postgres’s duplicate-database error once it does not',
        actual: outcomes,
        expected: [`Run database ${run.name} is already claimed`, '42P04'],
      });
    } finally {
      await dropAllTestRunDatabases(admin, base);
      await run.runner.close();
      await admin.close();
    }
  },
  ddlTimeoutMs,
);

test(
  'ISSUE-260: a hung orphan is dropped past the run bound, a live run beside it is not',
  async () => {
    const sweeper = connect('postgres');
    const hungRun = await startRun();
    const liveRun = await startRun();
    const bound = { maxRunMs: 1_500 };
    try {
      // The orphan: its runner died, its suite session stays open and idle.
      const hungSession = connect(hungRun.name);
      await hungSession`select 1`;
      await hungRun.runner.close();
      // The live run: its runner holds the lock and its suite is connected.
      const liveSession = connect(liveRun.name);
      await liveSession`select 1`;
      await Bun.sleep(1_700);
      const early = await sweepTestRunDatabases(sweeper, base, RUN_BOUND);

      const dropped = await sweepUntilDropped(sweeper, hungRun.name, bound);

      assert({
        given:
          'an orphan whose session is older than the bound (runner gone) and a live run whose session is just as old but whose runner holds its lock',
        should:
          'keep the orphan while the bound is an hour, then drop it once the bound passed, sessions terminated, and never touch the live run',
        actual: {
          early,
          dropped,
          hungLeft: await exists(sweeper, hungRun.name),
          liveLeft: await exists(sweeper, liveRun.name),
        },
        expected: {
          early: [],
          dropped: [hungRun.name],
          hungLeft: false,
          liveLeft: true,
        },
      });
      await liveSession.close();
      await hungSession.close().catch(() => undefined);
    } finally {
      await dropAllTestRunDatabases(sweeper, base);
      await liveRun.runner.close();
      await sweeper.close();
    }
  },
  ddlTimeoutMs,
);
