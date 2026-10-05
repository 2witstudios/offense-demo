import { runnerOnlyIssue, testSupportIssue } from './boundaries-rules';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

describe('test support subpaths', () => {
  test('admits a testing subpath from suites and test support', () => {
    assert({
      given:
        '@offense-demo/errors/testing imported by unit, integration, e2e and support files',
      should: 'report no issue',
      actual: [
        'packages/domain/src/project.test.ts',
        'apps/web/src/ui/app.test.tsx',
        'packages/db/integration/outbox.integration.ts',
        'apps/web/integration/fixtures.ts',
        'apps/web/e2e/support/accounts.ts',
        'packages/domain/src/project.test-support.ts',
        'packages/redis/integration/test-support.ts',
      ].map((file) => testSupportIssue('@offense-demo/errors/testing', file)),
      expected: Array(7).fill(null),
    });
  });

  test('refuses a testing subpath from production source', () => {
    assert({
      given: '@offense-demo/errors/testing imported by a production module',
      should: 'report the production import of test support',
      actual: [
        testSupportIssue(
          '@offense-demo/errors/testing',
          'packages/db/src/outbox.ts',
        ),
        testSupportIssue(
          '@offense-demo/errors/testing',
          'apps/web/src/features/integration/sync.ts',
        ),
        testSupportIssue('@offense-demo/errors', 'packages/db/src/outbox.ts'),
      ],
      expected: [
        'production import of test support @offense-demo/errors/testing',
        'production import of test support @offense-demo/errors/testing',
        null,
      ],
    });
  });

  test('refuses a relative *.test-support module from production source (ISSUE-167)', () => {
    assert({
      given: 'a *.test-support module imported relatively by production code',
      should: 'report the production import of test support',
      actual: [
        testSupportIssue('./index.test-support', 'packages/db/src/index.ts'),
        testSupportIssue(
          '../auth/abuse.test-support.ts',
          'apps/web/src/features/account/username.ts',
        ),
        testSupportIssue('./support', 'packages/db/src/index.ts'),
      ],
      expected: [
        'production import of test support ./index.test-support',
        'production import of test support ../auth/abuse.test-support.ts',
        null,
      ],
    });
  });

  test('admits a relative *.test-support module from test code', () => {
    assert({
      given: 'a *.test-support module imported by suites and other support',
      should: 'report no issue',
      actual: [
        'packages/db/src/index.test.ts',
        'packages/db/integration/username-claim.integration.ts',
        'apps/web/src/features/auth/email-change.test-support.ts',
      ].map((file) => testSupportIssue('./index.test-support', file)),
      expected: [null, null, null],
    });
  });
});

describe('runner-only code (ISSUE-275)', () => {
  test('no workspace file, test or product, may import from the root scripts/, however the path is spelled', () => {
    assert({
      given:
        'imports of the runner-only Redis sweep from integration, unit-test, product and deep-relative files',
      should: 'report each one',
      actual: [
        runnerOnlyIssue(
          '../../../scripts/redis-whole-database',
          'packages/redis/integration/x.integration.ts',
        ),
        runnerOnlyIssue(
          '../../../../../scripts/redis-whole-database.ts',
          'apps/web/src/features/x/x.test.ts',
        ),
        runnerOnlyIssue(
          '../../../scripts/redis-whole-database',
          'packages/redis/src/namespaces.ts',
        ),
        runnerOnlyIssue(
          '../../../scripts/../scripts/redis-whole-database',
          'apps/web/integration/x.integration.ts',
        ),
      ],
      expected: [
        'import of runner-only code from ../../../scripts/redis-whole-database',
        'import of runner-only code from ../../../../../scripts/redis-whole-database.ts',
        'import of runner-only code from ../../../scripts/redis-whole-database',
        'import of runner-only code from ../../../scripts/../scripts/redis-whole-database',
      ],
    });
  });

  test('negative control: sibling, package and a workspace’s own scripts/ imports are not runner-only', () => {
    assert({
      given:
        'a sibling import, a package import, a folder named like scripts inside a workspace, and apps/web’s own scripts/ folder',
      should: 'report none',
      actual: [
        runnerOnlyIssue('./namespaces', 'packages/redis/src/testing.ts'),
        runnerOnlyIssue('@offense-demo/redis/namespaces', 'apps/web/src/x.ts'),
        runnerOnlyIssue('../feature-scripts/x', 'apps/web/src/x.ts'),
        runnerOnlyIssue('../scripts/auth-load/x', 'apps/web/src/y.test.ts'),
      ],
      expected: [null, null, null, null],
    });
  });
});
