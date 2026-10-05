import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  claimTestRunDatabase,
  sweepTestRunDatabases,
  testRunLockLost,
} from './test-runs';
import { base, dead, fakeAdmin, RUN_BOUND } from './test-runs.test-support';

setupRitewayBun();

describe('the liveness lock is tied to one session (ISSUE-250)', () => {
  test('a claim reports the backend that holds the lock', async () => {
    const { admin } = fakeAdmin({ databases: [], backendPid: 777 });

    assert({
      given: 'a claim made on backend 777',
      should: 'return 777, the session the lock lives on',
      actual: await claimTestRunDatabase(admin, dead),
      expected: 777,
    });
  });

  test('the lock is lost the moment the connection becomes another backend', async () => {
    const same = fakeAdmin({ databases: [], backendPid: 777 });
    const reconnected = fakeAdmin({ databases: [], backendPid: 778 });

    assert({
      given:
        'the claiming backend 777, seen from a connection still on 777 and from one that silently reconnected as 778',
      should: 'report the lock lost only after the reconnect',
      actual: [
        await testRunLockLost(same.admin, 777),
        await testRunLockLost(reconnected.admin, 777),
      ],
      expected: [false, true],
    });
  });
});

describe('a cut connection counts as a lost lock (ISSUE-250)', () => {
  test('a query that fails because the connection just died reports the lock lost, not an error', async () => {
    const dying = Object.assign(async () => [], {
      unsafe: async () => {
        throw new Error('Connection closed');
      },
    });

    assert({
      given: 'the first query on a connection Postgres has just terminated',
      should: 'report the lock lost instead of throwing out of the watcher',
      actual: await testRunLockLost(dying as never, 777),
      expected: true,
    });
  });
});

describe('a sweep never drops a database a session is using (ISSUE-250)', () => {
  test('skips a free-lock database that still has a connected session, and drops it once none is', async () => {
    const busyOnly = fakeAdmin({ databases: [dead], connected: [dead] });
    const idle = fakeAdmin({ databases: [dead], connected: [] });

    const whileConnected = await sweepTestRunDatabases(
      busyOnly.admin,
      base,
      RUN_BOUND,
    );
    const afterwards = await sweepTestRunDatabases(idle.admin, base, RUN_BOUND);

    assert({
      given:
        'a run database whose lock is free (its runner’s connection was cut) but whose suites are still connected, then the same with no session',
      should:
        'leave it alone while a suite is connected (negative control: it is dropped once none is), and release the lock it took',
      actual: {
        whileConnected,
        dropsWhileConnected: busyOnly.statements.filter((statement) =>
          statement.startsWith('drop'),
        ).length,
        unlocked: busyOnly.statements.some((statement) =>
          statement.includes('pg_advisory_unlock'),
        ),
        afterwards,
      },
      expected: {
        whileConnected: [],
        dropsWhileConnected: 0,
        unlocked: true,
        afterwards: [dead],
      },
    });
  });
});

describe('a hung orphan cannot keep its database forever (ISSUE-260)', () => {
  test('drops a free-lock database whose sessions are all older than the run bound, and never a live run’s', async () => {
    const orphan = fakeAdmin({ databases: [dead], hung: [dead] });
    const live = fakeAdmin({
      databases: [dead],
      hung: [dead],
      busy: [dead],
    });
    const young = fakeAdmin({ databases: [dead], connected: [dead] });

    const dropped = await sweepTestRunDatabases(orphan.admin, base, RUN_BOUND);
    const keptLive = await sweepTestRunDatabases(live.admin, base, RUN_BOUND);
    const keptYoung = await sweepTestRunDatabases(young.admin, base, RUN_BOUND);

    assert({
      given:
        'a run database whose runner lock is gone and whose sessions are all older than the bound; the same with the lock held; and the same with a session younger than the bound',
      should:
        'drop only the first (its sessions terminated by the forced drop), and keep the lock-held and the young-session ones',
      actual: {
        dropped,
        forcedDrops: orphan.statements.filter((statement) =>
          statement.includes('with (force)'),
        ).length,
        keptLive,
        keptYoung,
      },
      expected: {
        dropped: [dead],
        forcedDrops: 1,
        keptLive: [],
        keptYoung: [],
      },
    });
  });

  test('asks Postgres for session age against the injected bound', async () => {
    const { admin, statements } = fakeAdmin({
      databases: [dead],
      hung: [dead],
    });

    await sweepTestRunDatabases(admin, base, { maxRunMs: 1_234 });

    assert({
      given: 'a bound of 1,234 ms',
      should: 'put exactly that bound in the session-age query',
      actual: statements.some(
        (statement) =>
          statement.includes('pg_stat_activity') &&
          statement.includes('1234 * interval'),
      ),
      expected: true,
    });
  });
});
