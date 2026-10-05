import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  claimTestRunDatabase,
  dropAllTestRunDatabases,
  slotDatabaseOfRun,
  sweepTestRunDatabases,
  testRunDatabaseName,
  testRunToken,
} from './test-runs';
import {
  base,
  dead,
  fakeAdmin,
  live,
  RUN_BOUND,
} from './test-runs.test-support';

setupRitewayBun();

describe('test run database names', () => {
  test('a token is eight hex digits of the bytes it is given', () => {
    assert({
      given: 'four bytes from the runner CSPRNG',
      should: 'name them as eight lowercase hex digits',
      actual: testRunToken(new Uint8Array([0x0a, 0x1b, 0xff, 0x00])),
      expected: '0a1bff00',
    });
    expect(() => testRunToken(new Uint8Array([1, 2, 3]))).toThrow('four bytes');
  });

  test('a run database extends the slot test database and maps back to it', () => {
    const name = testRunDatabaseName('offense_demo_wt_abc_test', '0a1b2c3d');

    assert({
      given: 'a slot test database and a token',
      should: 'append _run_<token>, and map back to the slot database',
      actual: [name, slotDatabaseOfRun(name)],
      expected: [
        'offense_demo_wt_abc_test_run_0a1b2c3d',
        'offense_demo_wt_abc_test',
      ],
    });
  });

  test('refuses anything that is not a slot test database or a token', () => {
    assert({
      given: 'a dev database, a run database as the base, and a bad token',
      should: 'refuse each and map non-run names to nothing',
      actual: [
        (() => {
          try {
            return testRunDatabaseName('offense_demo_wt_abc', '0a1b2c3d');
          } catch (error) {
            return String(error);
          }
        })(),
        (() => {
          try {
            return testRunDatabaseName('offense_demo_test', 'XYZ');
          } catch (error) {
            return String(error);
          }
        })(),
        slotDatabaseOfRun('offense_demo_wt_abc_test'),
        slotDatabaseOfRun('offense_demo_test_run_0a1b2c3'),
      ],
      expected: [
        'Error: A run database extends a slot _test database, got "offense_demo_wt_abc"',
        'Error: A run token is eight lowercase hex digits',
        undefined,
        undefined,
      ],
    });
  });
});

describe('claimTestRunDatabase', () => {
  test('takes the lock, then creates the database from template0', async () => {
    const { admin, statements } = fakeAdmin({ databases: [] });

    await claimTestRunDatabase(admin, dead);

    assert({
      given: 'a free run name',
      should:
        'lock before it creates (so a sweep never sees it unlocked), then note which backend holds the lock',
      actual: statements.map(
        (statement) => statement.split(' ')[0] + ' ' + statement.split(' ')[1],
      ),
      expected: [
        "select pg_try_advisory_lock(hashtextextended('offense_demo_wt_abc_test_run_00000001',",
        'create database',
        'select pg_backend_pid()',
      ],
    });
  });

  test('refuses a name another live runner holds, without creating', async () => {
    const { admin, statements } = fakeAdmin({ databases: [], busy: [dead] });

    await expect(claimTestRunDatabase(admin, dead)).rejects.toThrow(
      `Run database ${dead} is already claimed`,
    );
    assert({
      given: 'a name whose lock is held',
      should: 'issue no create',
      actual: statements.some((statement) => statement.startsWith('create')),
      expected: false,
    });
  });
});

describe('sweepTestRunDatabases', () => {
  test('drops the free ones, skips the held ones, releases what it took', async () => {
    const { admin, statements } = fakeAdmin({
      databases: [
        dead,
        live,
        `${base}_run_zz`,
        'offense_demo_wt_abc_test_run_00000003x',
      ],
      busy: [live],
    });

    const dropped = await sweepTestRunDatabases(admin, base, RUN_BOUND);

    assert({
      given: 'one dead run, one live run and two names that are not runs',
      should: 'drop only the dead run, unlock it, and never touch the others',
      actual: {
        dropped,
        drops: statements.filter((statement) => statement.startsWith('drop')),
        unlocks: statements.filter((statement) =>
          statement.includes('pg_advisory_unlock'),
        ).length,
      },
      expected: {
        dropped: [dead],
        drops: [`drop database if exists "${dead}" with (force)`],
        unlocks: 1,
      },
    });
  });
});

describe('dropAllTestRunDatabases', () => {
  test('drops every run of the slot, live or not', async () => {
    const { admin, statements } = fakeAdmin({ databases: [dead, live] });

    const dropped = await dropAllTestRunDatabases(admin, base);

    assert({
      given: 'two runs',
      should: 'drop both with force and name them',
      actual: { dropped, drops: statements.length },
      expected: { dropped: [dead, live], drops: 2 },
    });
  });
});
