import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices, requireTestSlotServices } from './index';

setupRitewayBun();

describe('requireTestServices', () => {
  // A worktree slot on port block 11: its own Redis database is 13.
  const testEnv = {
    DATABASE_URL: 'postgres://user:secret@localhost:5432/offense_demo_wt_abc',
    TEST_DATABASE_URL:
      'postgres://user:secret@localhost:5432/offense_demo_wt_abc_test_run_0a1b2c3d',
    TEST_RUN_DATABASE: 'offense_demo_wt_abc_test_run_0a1b2c3d',
    TEST_REDIS_URL: 'redis://localhost:6379/13',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '13110',
  };
  const failureOf = (env: Record<string, string | undefined>) => {
    try {
      requireTestServices(env);
      return 'accepted';
    } catch (error) {
      return String(error);
    }
  };
  const runRule =
    "Error: Integration suites require isolated test services: TEST_DATABASE_URL (must name this run's database, ending in _test_run_ and 8 hex digits: run suites with bun test:integration, which creates and drops it)";
  const refusal = (text: string) =>
    `Error: Integration suites require isolated test services: TEST_REDIS_URL (${text})`;
  const wrongDatabase = (index: number | string) =>
    refusal(
      `TEST_REDIS_URL names Redis database ${index}, expected this slot's own database 13 (run bun slot:up)`,
    );
  const wrongServer = refusal(
    "TEST_REDIS_URL names a different Redis server than REDIS_URL, expected this slot's shared Redis (run bun slot:up)",
  );

  test('hands a suite both isolated service URLs', () => {
    assert({
      given:
        'a test database URL ending in _test and the slot’s own Redis database on its server',
      should: 'return both URLs',
      actual: requireTestServices(testEnv),
      expected: {
        databaseUrl: testEnv.TEST_DATABASE_URL,
        redisUrl: testEnv.TEST_REDIS_URL,
      },
    });
  });

  test('throws, never skips, naming each missing or unsafe service', () => {
    assert({
      given:
        'no services, a non-test database, the slot database itself (no run), and a missing Redis URL',
      should:
        'throw naming the fields and the per-run rule, never a value: a suite can only run against a database the runner made for this run (ISSUE-238)',
      actual: [
        failureOf({}),
        failureOf({
          ...testEnv,
          TEST_DATABASE_URL:
            'postgres://user:secret@localhost:5432/offense_demo',
        }),
        failureOf({
          ...testEnv,
          TEST_DATABASE_URL:
            'postgres://user:secret@localhost:5432/offense_demo_test',
        }),
        failureOf({ TEST_DATABASE_URL: testEnv.TEST_DATABASE_URL }),
      ],
      expected: [
        'Error: Integration suites require isolated test services: TEST_DATABASE_URL, TEST_REDIS_URL',
        runRule,
        runRule,
        'Error: Integration suites require isolated test services: TEST_REDIS_URL',
      ],
    });
  });

  test('ISSUE-245: refuses a Redis database that is not the slot’s own, so a suite run directly cannot touch another', () => {
    const on = (url: string) => failureOf({ ...testEnv, TEST_REDIS_URL: url });

    assert({
      given:
        'the slot’s own database, another slot’s (5), dev (0), e2e (2), main’s (1), 512 and a padded index',
      should: 'accept only exactly database 13',
      actual: [
        on('redis://localhost:6379/13'),
        on('redis://localhost:6379/5'),
        on('redis://localhost:6379/0'),
        on('redis://localhost:6379/2'),
        on('redis://localhost:6379/1'),
        on('redis://localhost:6379/512'),
        on('redis://localhost:6379/013'),
      ],
      expected: [
        'accepted',
        wrongDatabase(5),
        wrongDatabase(0),
        wrongDatabase(2),
        wrongDatabase(1),
        wrongDatabase(512),
        wrongDatabase('013'),
      ],
    });
    assert({
      given:
        'main (no PORT, as in CI) on database 1, on 0, and a PORT naming no block',
      should: 'accept main on 1 only, and refuse to guess from a bad PORT',
      actual: [
        failureOf({
          ...testEnv,
          PORT: undefined,
          TEST_REDIS_URL: 'redis://localhost:6379/1',
        }),
        failureOf({
          ...testEnv,
          PORT: undefined,
          TEST_REDIS_URL: 'redis://localhost:6379/0',
        }),
        failureOf({ ...testEnv, PORT: '13115' }),
      ],
      expected: [
        'accepted',
        refusal(
          "TEST_REDIS_URL names Redis database 0, expected this slot's own database 1 (run bun slot:up)",
        ),
        refusal(
          "PORT does not name this slot's port block, so its test Redis database cannot be derived (run bun slot:up)",
        ),
      ],
    });
  });

  test('ISSUE-245: refuses the slot’s own database number on another server, and accepts any spelling of the same one', () => {
    const on = (url: string, redis = testEnv.REDIS_URL) =>
      failureOf({ ...testEnv, TEST_REDIS_URL: url, REDIS_URL: redis });

    assert({
      given:
        'another port, a non-loopback host, no REDIS_URL, and 127.0.0.1, [::1] and localhost spellings of the slot’s server',
      should: 'refuse the first three and accept the same-server spellings',
      actual: [
        on('redis://127.0.0.1:6391/13'),
        on('redis://cache.example.com:6379/13'),
        failureOf({ ...testEnv, REDIS_URL: undefined }),
        on('redis://127.0.0.1:6379/13'),
        on('redis://[::1]:6379/13', 'redis://localhost:6379/0'),
        on('redis://localhost/13', 'redis://127.0.0.1:6379'),
      ],
      expected: [
        wrongServer,
        wrongServer,
        refusal(
          "REDIS_URL is unset, so this slot's Redis server cannot be told from another (run bun slot:up)",
        ),
        'accepted',
        'accepted',
        'accepted',
      ],
    });
  });
});

describe('requireTestSlotServices', () => {
  const slotEnv = {
    DATABASE_URL: 'postgres://user:secret@localhost:5432/offense_demo',
    TEST_DATABASE_URL:
      'postgres://user:secret@localhost:5432/offense_demo_test',
    TEST_REDIS_URL: 'redis://localhost:6379/1',
    REDIS_URL: 'redis://localhost:6379',
  };
  const failureOf = (env: Record<string, string | undefined>) => {
    try {
      requireTestSlotServices(env);
      return 'accepted';
    } catch (error) {
      return String(error);
    }
  };
  const slotRule =
    'Error: Integration suites require isolated test services: TEST_DATABASE_URL (must name a database ending in _test)';

  test('hands the runner the slot database the run databases derive from', () => {
    assert({
      given: 'main’s slot _test database and its own Redis database',
      should: 'return both URLs',
      actual: requireTestSlotServices(slotEnv),
      expected: {
        databaseUrl: slotEnv.TEST_DATABASE_URL,
        redisUrl: slotEnv.TEST_REDIS_URL,
      },
    });
  });

  test('refuses a database that is not a slot _test database (a run never starts a run)', () => {
    assert({
      given: 'a dev database and a run database',
      should: 'name TEST_DATABASE_URL and the _test rule',
      actual: [
        failureOf({
          ...slotEnv,
          TEST_DATABASE_URL:
            'postgres://user:secret@localhost:5432/offense_demo',
        }),
        failureOf({
          ...slotEnv,
          TEST_DATABASE_URL:
            'postgres://user:secret@localhost:5432/offense_demo_test_run_0a1b2c3d',
        }),
      ],
      expected: [slotRule, slotRule],
    });
  });

  test('ISSUE-245: the runner’s reader applies the same Redis rule, so it never sweeps or scans another database or server', () => {
    const redisRefusal = (text: string) =>
      `Error: Integration suites require isolated test services: TEST_REDIS_URL (${text})`;

    assert({
      given:
        'main on database 1 (accepted), on dev 0, on another slot’s 5, and on database 1 of another server',
      should: 'accept only main’s own database on its own server',
      actual: [
        failureOf(slotEnv),
        failureOf({ ...slotEnv, TEST_REDIS_URL: 'redis://localhost:6379/0' }),
        failureOf({ ...slotEnv, TEST_REDIS_URL: 'redis://localhost:6379/5' }),
        failureOf({
          ...slotEnv,
          TEST_REDIS_URL: 'redis://127.0.0.1:6391/1',
        }),
      ],
      expected: [
        'accepted',
        redisRefusal(
          "TEST_REDIS_URL names Redis database 0, expected this slot's own database 1 (run bun slot:up)",
        ),
        redisRefusal(
          "TEST_REDIS_URL names Redis database 5, expected this slot's own database 1 (run bun slot:up)",
        ),
        redisRefusal(
          "TEST_REDIS_URL names a different Redis server than REDIS_URL, expected this slot's shared Redis (run bun slot:up)",
        ),
      ],
    });
  });
});
