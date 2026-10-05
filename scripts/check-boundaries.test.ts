import {
  adminSurfaceIssue,
  allowedWorkspaceDependencies,
  deepImportIssue,
  domainPurityIssue,
  pureWorkspaces,
  forbiddenDependencyIssue,
} from './boundaries-rules';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const workspaces = [
  '@offense-demo/web',
  '@offense-demo/domain',
  '@offense-demo/protocol',
  '@offense-demo/db',
  '@offense-demo/redis',
  '@offense-demo/auth',
  '@offense-demo/errors',
  '@offense-demo/config',
  '@offense-demo/clock',
  '@offense-demo/logger',
  '@offense-demo/observability',
  '@offense-demo/typescript-config',
] as const;

describe('domain purity rule', () => {
  for (const name of workspaces) {
    if (name === '@offense-demo/domain') continue;
    test(`${name} is not subject to the domain purity rule`, () => {
      assert({
        given: `${name} declaring and importing a third-party package`,
        should: 'report no purity issue',
        actual: [
          domainPurityIssue(name, 'zod', 'dependency'),
          domainPurityIssue(name, 'node:fs', 'import', 'packages/x/src/a.ts'),
        ],
        expected: [null, null],
      });
    });
  }

  test('the domain may not declare a third-party runtime dependency', () => {
    assert({
      given: '@offense-demo/domain declaring zod',
      should: 'report a purity issue',
      actual: domainPurityIssue('@offense-demo/domain', 'zod', 'dependency'),
      expected: '@offense-demo/domain: dependency zod breaks domain purity',
    });
  });

  test('domain production code may not import platform or vendor modules', () => {
    assert({
      given: 'domain source importing node:fs, bun and drizzle-orm',
      should: 'report a purity issue for each',
      actual: ['node:fs', 'bun', 'drizzle-orm'].map((specifier) =>
        domainPurityIssue(
          '@offense-demo/domain',
          specifier,
          'import',
          'packages/domain/src/project.ts',
        ),
      ),
      expected: [
        '@offense-demo/domain: import node:fs breaks domain purity',
        '@offense-demo/domain: import bun breaks domain purity',
        '@offense-demo/domain: import drizzle-orm breaks domain purity',
      ],
    });
  });

  test('workspace, relative and test-runner imports stay allowed', () => {
    assert({
      given:
        'domain importing @offense-demo/errors, a sibling module, and riteway from a test',
      should: 'report no issue',
      actual: [
        domainPurityIssue(
          '@offense-demo/domain',
          '@offense-demo/errors',
          'import',
          'packages/domain/src/project.ts',
        ),
        domainPurityIssue(
          '@offense-demo/domain',
          './invariant-ids',
          'import',
          'packages/domain/src/project.ts',
        ),
        domainPurityIssue(
          '@offense-demo/domain',
          'riteway/bun',
          'import',
          'packages/domain/src/project.test.ts',
        ),
      ],
      expected: [null, null, null],
    });
  });

  test('the pure set is exactly the domain', () => {
    assert({
      given: 'the pure workspace list',
      should: 'name exactly @offense-demo/domain',
      actual: [...pureWorkspaces],
      expected: ['@offense-demo/domain'],
    });
  });

  test('the domain depends on errors only', () => {
    assert({
      given: 'the domain declaring @offense-demo/db',
      should: 'report a forbidden dependency',
      actual: forbiddenDependencyIssue(
        'packages/domain',
        '@offense-demo/domain',
        '@offense-demo/db',
        allowedWorkspaceDependencies,
      ),
      expected: 'packages/domain: forbidden dependency @offense-demo/db',
    });
  });
});

describe('realtime workspace edges (ADR 0031 §12)', () => {
  test('the allowlist names exactly the ADR 0031 §12 edges', () => {
    assert({
      given: 'allowedWorkspaceDependencies.realtime',
      should: 'list exactly the edges the ADR mechanically enforces',
      actual: [...allowedWorkspaceDependencies.realtime!].sort(),
      expected: [
        'auth',
        'clock',
        'config',
        'db',
        'errors',
        'logger',
        'observability',
        'protocol',
        'redis',
      ].sort(),
    });
  });

  test('a realtime manifest depending on domain is forbidden', () => {
    assert({
      given: 'apps/realtime declaring @offense-demo/domain',
      should: 'report a forbidden dependency',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@offense-demo/realtime',
        '@offense-demo/domain',
        allowedWorkspaceDependencies,
      ),
      expected: 'apps/realtime: forbidden dependency @offense-demo/domain',
    });
  });

  test('a realtime manifest depending on apps/web is forbidden', () => {
    assert({
      given: 'apps/realtime declaring @offense-demo/web',
      should: 'report a forbidden dependency',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@offense-demo/realtime',
        '@offense-demo/web',
        allowedWorkspaceDependencies,
      ),
      expected: 'apps/realtime: forbidden dependency @offense-demo/web',
    });
  });

  test('a realtime manifest depending on one of its allowed edges is not flagged', () => {
    assert({
      given: 'apps/realtime declaring @offense-demo/protocol',
      should: 'report no issue',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@offense-demo/realtime',
        '@offense-demo/protocol',
        allowedWorkspaceDependencies,
      ),
      expected: null,
    });
  });

  test('deleting the realtime key removes the restriction entirely', () => {
    const withoutRealtime = Object.fromEntries(
      Object.entries(allowedWorkspaceDependencies).filter(
        ([key]) => key !== 'realtime',
      ),
    );

    assert({
      given: 'the realtime key removed from allowedWorkspaceDependencies',
      should:
        'no longer forbid @offense-demo/domain, proving the fixture is load-bearing',
      actual: forbiddenDependencyIssue(
        'apps/realtime',
        '@offense-demo/realtime',
        '@offense-demo/domain',
        withoutRealtime,
      ),
      expected: null,
    });
  });
});

describe('workspace deep imports', () => {
  const exportsOf = (name: string) =>
    name === '@offense-demo/errors'
      ? { '.': './src/index.ts', './testing': './src/testing.ts' }
      : { '.': './src/index.ts' };

  test('admits a package root and a subpath the package exports', () => {
    assert({
      given: "a package's root and a subpath named in its exports map",
      should: 'report no issue for either',
      actual: [
        deepImportIssue('@offense-demo/errors', exportsOf),
        deepImportIssue('@offense-demo/errors/testing', exportsOf),
      ],
      expected: [null, null],
    });
  });

  test('refuses a subpath the package does not export', () => {
    assert({
      given: 'a reach into a source file the exports map does not name',
      should: 'report the deep import',
      actual: [
        deepImportIssue('@offense-demo/errors/src/index', exportsOf),
        deepImportIssue('@offense-demo/db/schema', exportsOf),
      ],
      expected: [
        'workspace deep import @offense-demo/errors/src/index',
        'workspace deep import @offense-demo/db/schema',
      ],
    });
  });

  test('ignores packages outside the workspace', () => {
    assert({
      given: 'a subpath import of a third-party package',
      should: 'leave it to the dependency rules',
      actual: deepImportIssue('drizzle-orm/pg-core', exportsOf),
      expected: null,
    });
  });
});

describe('no admin surface in the participant app (ADR 0043)', () => {
  test('flags an admin route segment under the app router', () => {
    assert({
      given:
        'a route segment named admin, plain or grouped, under apps/web/src/app',
      should: 'report an admin surface issue',
      actual: [
        'apps/web/src/app/admin/page.tsx',
        'apps/web/src/app/(admin)/dashboard/page.tsx',
        'apps/web/src/app/api/admin/route.ts',
      ].map((file) => adminSurfaceIssue(file)),
      expected: [
        'apps/web/src/app/admin/page.tsx: admin surface in the participant app (ADR 0043)',
        'apps/web/src/app/(admin)/dashboard/page.tsx: admin surface in the participant app (ADR 0043)',
        'apps/web/src/app/api/admin/route.ts: admin surface in the participant app (ADR 0043)',
      ],
    });
  });

  test('flags a feature or module named admin anywhere under apps/web', () => {
    assert({
      given: 'a feature directory or a module file named admin',
      should: 'report an admin surface issue',
      actual: [
        'apps/web/src/features/admin/index.ts',
        'apps/web/src/lib/admin.ts',
        'apps/web/src/ui/admin.test.tsx',
      ].map((file) => adminSurfaceIssue(file)),
      expected: [
        'apps/web/src/features/admin/index.ts: admin surface in the participant app (ADR 0043)',
        'apps/web/src/lib/admin.ts: admin surface in the participant app (ADR 0043)',
        'apps/web/src/ui/admin.test.tsx: admin surface in the participant app (ADR 0043)',
      ],
    });
  });

  test('leaves ordinary participant routes, features and near-miss names alone', () => {
    assert({
      given:
        'legitimate participant paths and names that merely start with admin',
      should: 'report no issue',
      actual: [
        'apps/web/src/app/(shell)/profile/page.tsx',
        'apps/web/src/features/access/index.ts',
        'apps/web/src/lib/administration.ts',
        'packages/db/src/slots.ts',
      ].map((file) => adminSurfaceIssue(file)),
      expected: [null, null, null, null],
    });
  });
});
