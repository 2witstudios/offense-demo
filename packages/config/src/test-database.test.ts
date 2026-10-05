import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices, requireTestSlotServices } from './index';

setupRitewayBun();

// A worktree slot (block 11): its dev database, this run's database, its Redis.
const testEnv = {
  DATABASE_URL: 'postgres://user:secret@localhost:5432/offense_demo_wt_abc',
  TEST_DATABASE_URL:
    'postgres://user:secret@localhost:5432/offense_demo_wt_abc_test_run_0a1b2c3d',
  TEST_RUN_DATABASE: 'offense_demo_wt_abc_test_run_0a1b2c3d',
  TEST_REDIS_URL: 'redis://localhost:6379/13',
  REDIS_URL: 'redis://localhost:6379',
  PORT: '13110',
};
const failureOf = (
  read: (env: Record<string, string | undefined>) => unknown,
  env: Record<string, string | undefined>,
) => {
  try {
    read(env);
    return 'accepted';
  } catch (error) {
    return String(error);
  }
};

describe('the run database a suite may use (ISSUE-249)', () => {
  const suite = (env: Record<string, string | undefined>) =>
    failureOf(requireTestServices, env);
  const dbRefusal = (text: string) =>
    `Error: Integration suites require isolated test services: TEST_DATABASE_URL (${text})`;
  const notThisRun = dbRefusal(
    "must name this run's own database, the one the runner handed this process as TEST_RUN_DATABASE: run suites with bun test:integration, which creates and drops it",
  );
  const notThisSlot = dbRefusal(
    'must name a database of this slot, derived from DATABASE_URL: run suites with bun test:integration (run bun slot:up)',
  );
  const wrongPostgres = dbRefusal(
    "names a different Postgres server than DATABASE_URL, expected this slot's shared Postgres (run bun slot:up)",
  );
  const withRun = (name: string, host = 'localhost:5432') => ({
    ...testEnv,
    TEST_DATABASE_URL: `postgres://user:secret@${host}/${name}`,
  });

  test('ISSUE-249: refuses a run database that is not this run’s own, in this slot, on this slot’s server', () => {
    assert({
      given:
        'this slot with another run’s token, another slot’s run database, main’s, an unset TEST_RUN_DATABASE, and a well-formed name on another host and another port',
      should:
        'accept only the exact run the runner handed this process, so a suite started by hand can never purge another database',
      actual: [
        suite(testEnv),
        suite(withRun('offense_demo_wt_abc_test_run_deadbeef')),
        suite(withRun('offense_demo_wt_zzzzzzzz_test_run_0a1b2c3d')),
        suite(withRun('offense_demo_test_run_0a1b2c3d')),
        suite({ ...testEnv, TEST_RUN_DATABASE: undefined }),
        suite(
          withRun('offense_demo_wt_abc_test_run_0a1b2c3d', '10.255.255.1:5432'),
        ),
        suite(
          withRun('offense_demo_wt_abc_test_run_0a1b2c3d', 'localhost:5499'),
        ),
        suite({ ...testEnv, DATABASE_URL: undefined }),
      ],
      expected: [
        'accepted',
        notThisRun,
        notThisSlot,
        notThisSlot,
        notThisRun,
        wrongPostgres,
        wrongPostgres,
        dbRefusal(
          "DATABASE_URL is unset, so this slot's Postgres server and databases cannot be told from another (run bun slot:up)",
        ),
      ],
    });
  });

  test('ISSUE-249: any spelling of the same server is the same server, and the CI shape (DATABASE_URL on offense_demo_test) works', () => {
    assert({
      given:
        '127.0.0.1 and [::1] spellings, the default port, and CI’s DATABASE_URL naming offense_demo_test',
      should: 'accept them all',
      actual: [
        suite(
          withRun('offense_demo_wt_abc_test_run_0a1b2c3d', '127.0.0.1:5432'),
        ),
        suite(withRun('offense_demo_wt_abc_test_run_0a1b2c3d', '[::1]:5432')),
        suite({
          ...withRun('offense_demo_wt_abc_test_run_0a1b2c3d', 'localhost'),
          DATABASE_URL:
            'postgres://user:secret@127.0.0.1:5432/offense_demo_wt_abc',
        }),
        suite({
          ...testEnv,
          DATABASE_URL:
            'postgres://user:secret@localhost:5432/offense_demo_test',
          TEST_DATABASE_URL:
            'postgres://user:secret@localhost:5432/offense_demo_test_run_0a1b2c3d',
          TEST_RUN_DATABASE: 'offense_demo_test_run_0a1b2c3d',
          TEST_REDIS_URL: 'redis://localhost:6379/1',
          PORT: undefined,
        }),
      ],
      expected: ['accepted', 'accepted', 'accepted', 'accepted'],
    });
  });
});

describe('the slot database the runner may use (ISSUE-249)', () => {
  const slotEnv = {
    DATABASE_URL: 'postgres://user:secret@localhost:5432/offense_demo',
    TEST_DATABASE_URL:
      'postgres://user:secret@localhost:5432/offense_demo_test',
    TEST_REDIS_URL: 'redis://localhost:6379/1',
    REDIS_URL: 'redis://localhost:6379',
  };
  const failureOfSlot = (env: Record<string, string | undefined>) =>
    failureOf(requireTestSlotServices, env);
  test('ISSUE-249: the runner creates and drops databases only in this slot and on this slot’s server', () => {
    const on = (url: string) =>
      failureOfSlot({ ...slotEnv, TEST_DATABASE_URL: url });
    const notThisSlot =
      "Error: Integration suites require isolated test services: TEST_DATABASE_URL (must name this slot's own test database, derived from DATABASE_URL: run bun slot:up)";

    assert({
      given:
        'main’s DATABASE_URL with its own _test database, another slot’s _test database, and its own name on another host and port',
      should: 'accept only this slot’s own test database on its own server',
      actual: [
        on('postgres://user:secret@localhost:5432/offense_demo_test'),
        on(
          'postgres://user:secret@localhost:5432/offense_demo_wt_zzzzzzzz_test',
        ),
        on('postgres://user:secret@10.255.255.1:5432/offense_demo_test'),
        on('postgres://user:secret@localhost:5499/offense_demo_test'),
      ],
      expected: [
        'accepted',
        notThisSlot,
        "Error: Integration suites require isolated test services: TEST_DATABASE_URL (names a different Postgres server than DATABASE_URL, expected this slot's shared Postgres (run bun slot:up))",
        "Error: Integration suites require isolated test services: TEST_DATABASE_URL (names a different Postgres server than DATABASE_URL, expected this slot's shared Postgres (run bun slot:up))",
      ],
    });
  });
});
