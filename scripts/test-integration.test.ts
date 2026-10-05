import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import rootPackage from '../package.json';
import {
  claimsIntegrationSuite,
  discoverSuites,
  exitCodeOf,
  grownTables,
  INTEGRATION_RUNNER,
  integrationSuites,
  redisLeakMessages,
  redisSweepMessage,
  sweepMessage,
  withSelectedSuites,
} from './test-integration';

setupRitewayBun();

describe('integration suite discovery', () => {
  test('finds suites by folder and suffix, in a stable order', () => {
    assert({
      given:
        'files under integration/ and elsewhere, and an old .integration.test.ts name',
      should: 'keep integration suites only, sorted',
      actual: integrationSuites([
        'integration/redis.integration.ts',
        'integration/seed.integration.ts',
        'integration/legacy.integration.test.ts',
        'integration/webauthn-authenticator.smoke.integration.ts',
        'integration/support/fixtures.ts',
        'src/index.test.ts',
        'integration/nested/outbox.integration.ts',
      ]),
      expected: [
        'integration/nested/outbox.integration.ts',
        'integration/redis.integration.ts',
        'integration/seed.integration.ts',
        'integration/webauthn-authenticator.smoke.integration.ts',
      ],
    });
  });

  test('lets bun evidence count every discovered suite as claimed', () => {
    assert({
      given: 'the discovery runner, and a hand-kept list that misses a file',
      should: 'claim any suite under integration/ only for the runner',
      actual: [
        claimsIntegrationSuite(
          INTEGRATION_RUNNER,
          'packages/db/integration/new.integration.ts',
        ),
        claimsIntegrationSuite(
          'bun test ./integration/old.integration.ts',
          'packages/db/integration/new.integration.ts',
        ),
        claimsIntegrationSuite(
          INTEGRATION_RUNNER,
          'packages/db/src/not-integration.ts',
        ),
        // The runner scans only <workspace>/integration/, never a nested one.
        claimsIntegrationSuite(
          INTEGRATION_RUNNER,
          'packages/db/src/outbox/integration/x.integration.ts',
        ),
      ],
      expected: [true, false, false, false],
    });
  });
});

describe('running the suites', () => {
  test('discovers .tsx suites as well as .ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grd-6-integration-'));
    mkdirSync(join(dir, 'integration'));
    for (const name of ['ui.integration.tsx', 'db.integration.ts', 'x.ts'])
      writeFileSync(join(dir, 'integration', name), '');
    assert({
      given:
        'an integration folder with a .tsx suite, a .ts suite and a helper',
      should:
        'run both suites, so bun evidence never counts one that is skipped',
      actual: discoverSuites(dir),
      expected: [
        'integration/db.integration.ts',
        'integration/ui.integration.tsx',
      ],
    });
  });

  test('fails when bun test dies from a signal', () => {
    const killed = Bun.spawnSync(['sh', '-c', 'kill -9 $$']);
    assert({
      given:
        'a run killed by SIGKILL (exit code null), a failing run and a passing one',
      should: 'exit non-zero for the first two and zero for the last',
      actual: [
        exitCodeOf(killed),
        exitCodeOf({ exitCode: 3, signalCode: null }),
        exitCodeOf({ exitCode: 0, signalCode: null }),
      ],
      expected: [137, 3, 0],
    });
  });

  test("runs one workspace's suites at a time, never two against the shared test database", () => {
    // ISSUE-61, ISSUE-100: @offense-demo/db's out-of-order proof holds transaction
    // A open on outbox while it inserts B; @offense-demo/web's fixtures CREATE
    // TRIGGER on outbox and session. Run side by side on one database, the
    // queued trigger waits on A and B's insert waits on the trigger: a lock
    // queue Postgres cannot see as a deadlock, since A waits on B in the
    // client, so the db tests hit their timeout and the web app's
    // lock_timeout answers 502.
    assert({
      given: 'the root test:integration script',
      should: 'run turbo with a concurrency of one',
      actual: rootPackage.scripts['test:integration']
        .split(/\s+/)
        .includes('--concurrency=1'),
      expected: true,
    });
  });
});

describe('ISSUE-192 test database row ledger', () => {
  test('names every table a run left with more rows than it started with', () => {
    assert({
      given:
        'row counts before and after a run: one table grew, one shrank, one is new with rows, one is new and empty',
      should: 'report the grown and the new non-empty tables only, sorted',
      actual: grownTables(
        { email_delivery: 84_725, session: 3, users: 0, formats: 1 },
        {
          email_delivery: 88_840,
          session: 0,
          users: 0,
          formats: 1,
          outbox: 2,
          ballots: 0,
        },
      ),
      expected: [
        { table: 'email_delivery', before: 84_725, after: 88_840 },
        { table: 'outbox', before: 0, after: 2 },
      ],
    });
  });

  test('reports nothing when a run leaves every table as it found it', () => {
    assert({
      given: 'identical row counts before and after',
      should: 'report no table',
      actual: grownTables({ users: 2, formats: 1 }, { users: 2, formats: 1 }),
      expected: [],
    });
  });
});

describe('test Redis hygiene messages (ISSUE-237)', () => {
  test('says nothing when nothing was swept', () => {
    assert({
      given: 'a sweep that found no stale namespace',
      should: 'print no line',
      actual: redisSweepMessage({ namespaces: [], keys: 0 }),
      expected: undefined,
    });
  });

  test('reports what a sweep removed', () => {
    assert({
      given: 'a sweep of 78,208 keys in 85 namespaces',
      should: 'say how many keys and namespaces earlier runs left behind',
      actual: redisSweepMessage({
        namespaces: Array.from({ length: 85 }, (_, index) => `t3-${index}`),
        keys: 78_208,
      }),
      expected:
        'test-integration: swept 78208 stale test Redis keys in 85 namespaces left by earlier runs (ISSUE-237)',
    });
  });

  test('names every key a run left without an expiry, capped at ten', () => {
    const immortal = Array.from(
      { length: 12 },
      (_, index) => `t3-x:v1:k${String(index).padStart(2, '0')}`,
    );

    assert({
      given: 'a run that left 12 keys with no TTL',
      should:
        'print the count once and the first ten names, so the offending suite is findable',
      actual: redisLeakMessages(immortal),
      expected: [
        'test-integration: 12 test Redis keys had no expiry after the run and were removed (ISSUE-237); every test key must expire',
        ...immortal.slice(0, 10).map((key) => `test-integration:   ${key}`),
        'test-integration:   ...and 2 more',
      ],
    });
    assert({
      given: 'a run that left no immortal key',
      should: 'print nothing',
      actual: redisLeakMessages([]),
      expected: [],
    });
  });
});

describe('running chosen suites (ISSUE-238)', () => {
  const suites = [
    'integration/a.integration.ts',
    'integration/nested/b.integration.ts',
  ];

  test('runs every suite when no file is named', () => {
    assert({
      given: 'two suites and only a bun test flag',
      should: 'run both and pass the flag on',
      actual: withSelectedSuites(suites, ['-t', 'pattern']),
      expected: {
        files: suites,
        rest: ['-t', 'pattern'],
      },
    });
  });

  test('runs only the named suites, however the path is spelled', () => {
    assert({
      given: 'a suite named with ./ and one by its plain path, plus a flag',
      should: 'select exactly those two and keep the flag',
      actual: withSelectedSuites(suites, [
        './integration/nested/b.integration.ts',
        'integration/a.integration.ts',
        '--bail',
      ]),
      expected: { files: [suites[1], suites[0]], rest: ['--bail'] },
    });
  });

  test('a named file that is not a suite is an error, not a silent full run', () => {
    let failure = 'accepted';
    try {
      withSelectedSuites(suites, ['integration/missing.integration.ts']);
    } catch (error) {
      failure = String(error);
    }

    assert({
      given: 'a file that is not one of the workspace’s suites',
      should: 'refuse it by name',
      actual: failure,
      expected:
        'Error: test-integration: integration/missing.integration.ts is not an integration suite of this workspace',
    });
  });

  test('reports the run databases a sweep dropped, and is silent otherwise', () => {
    assert({
      given: 'no dropped databases, and two',
      should: 'print nothing, then name the count and the databases',
      actual: [
        sweepMessage([]),
        sweepMessage([
          'offense_demo_test_run_00000001',
          'offense_demo_test_run_00000002',
        ]),
      ],
      expected: [
        undefined,
        'test-integration: dropped 2 test databases left by runs that died (ISSUE-238): offense_demo_test_run_00000001, offense_demo_test_run_00000002',
      ],
    });
  });
});
