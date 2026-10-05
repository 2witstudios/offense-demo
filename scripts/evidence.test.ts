import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  ciGateProblems,
  ciInvokedTasks,
  classifyTestFile,
  isTestFilePath,
  orphanSuiteDetail,
  rootClaimProblems,
} from './evidence';

setupRitewayBun();

describe('isTestFilePath', () => {
  test('recognizes the three suite suffixes and nothing else', () => {
    assert({
      given: 'unit, integration, e2e, and non-test paths',
      should: 'classify only suite files',
      actual: [
        'packages/db/src/index.test.ts',
        'packages/db/integration/db.integration.ts',
        'apps/web/e2e/app.e2e.ts',
        'packages/db/src/index.ts',
        'README.md',
      ].map(isTestFilePath),
      expected: [true, true, true, false, false],
    });
  });

  test('sees TSX suites so they cannot hide from the gate', () => {
    assert({
      given: 'React component, integration, and e2e suites written in TSX',
      should: 'treat every one as a suite file, and a plain component as not',
      actual: [
        'apps/web/src/ui/store/store.test.tsx',
        'apps/web/src/ui/store/store.integration.tsx',
        'apps/web/e2e/app.e2e.tsx',
        'apps/web/src/ui/store/store.tsx',
      ].map(isTestFilePath),
      expected: [true, true, true, false],
    });
  });
});

describe('classifyTestFile', () => {
  test('routes each suite to its claiming runner', () => {
    assert({
      given: 'one file per tier',
      should: 'assign the tier whose runner claims it',
      actual: {
        unit: classifyTestFile('packages/protocol/src/index.test.ts'),
        rootScript: classifyTestFile('scripts/doctor.test.ts'),
        cli: classifyTestFile('cli/init.test.ts'),
        create: classifyTestFile('create/create.test.ts'),
        rootConfig: classifyTestFile('eslint.config.test.ts'),
        integration: classifyTestFile(
          'apps/web/integration/foundation.integration.ts',
        ),
        e2e: classifyTestFile('apps/web/e2e/app.e2e.ts'),
      },
      expected: {
        unit: 'unit',
        rootScript: 'root-script',
        cli: 'root-script',
        create: 'root-script',
        rootConfig: 'root-config',
        integration: 'integration',
        e2e: 'e2e',
      },
    });
  });

  test('flags suites outside claimed locations as orphans', () => {
    assert({
      given: 'a test file at a package root instead of src/',
      should: 'mark it an orphan',
      actual: classifyTestFile('packages/db/misplaced.test.ts'),
      expected: 'orphan',
    });
  });

  test('claims TSX unit suites wherever bun test executes them', () => {
    assert({
      given: '.test.tsx files under a workspace src/ and under root scripts/',
      should: 'assign the tier of the bun test runner that globs them',
      actual: [
        'apps/web/src/ui/components/nav-item/nav-item.render.test.tsx',
        'apps/web/src/ui/store/store.test.tsx',
        'scripts/report.test.tsx',
      ].map(classifyTestFile),
      expected: ['unit', 'unit', 'root-script'],
    });
  });

  test('flags a TSX unit suite outside claimed locations as an orphan', () => {
    assert({
      given: 'a .test.tsx file beside src/ instead of inside it',
      should: 'mark it an orphan',
      actual: classifyTestFile('apps/web/components/button.test.tsx'),
      expected: 'orphan',
    });
  });

  test('flags integration and e2e suffixes under src/ as orphans', () => {
    assert({
      given:
        'an .integration.ts and an .e2e.ts under a workspace src/, which bun test src never globs',
      should: 'mark both orphans instead of counting them as unit suites',
      actual: [
        'packages/db/src/foo.integration.ts',
        'packages/db/src/foo.e2e.ts',
      ].map(classifyTestFile),
      expected: ['orphan', 'orphan'],
    });
  });

  test('keeps real integration and e2e directories claimed', () => {
    assert({
      given: 'suites under integration/ and apps/web/e2e/',
      should: 'stay claimed by their own runners',
      actual: [
        'packages/db/integration/db.integration.ts',
        'packages/db/integration/seed.integration.ts',
        'apps/web/e2e/app.e2e.ts',
      ].map(classifyTestFile),
      expected: ['integration', 'integration', 'e2e'],
    });
  });

  test('claims a workspace operational script suite outside the top-level scripts/ folder', () => {
    assert({
      given:
        "a .test.ts under a workspace's own scripts/ directory (not the root one)",
      should: 'assign workspace-script, distinct from the root scripts/ runner',
      actual: [
        classifyTestFile('apps/web/scripts/auth-load/metrics.test.ts'),
        classifyTestFile('scripts/doctor.test.ts'),
      ],
      expected: ['workspace-script', 'root-script'],
    });
  });

  test('flags scripts/ and src/ suites outside any workspace as orphans (ISSUE-171)', () => {
    assert({
      given:
        'a scripts/ and a src/ suite under a directory that is neither apps/* nor packages/*',
      should: 'classify both orphan, since no workspace runner executes them',
      actual: [
        classifyTestFile('infra/scripts/x.test.ts'),
        classifyTestFile('infra/src/z.test.ts'),
      ],
      expected: ['orphan', 'orphan'],
    });
  });

  test('flags an integration/ suite outside any workspace as an orphan (ISSUE-180)', () => {
    assert({
      given:
        'an integration/ suite under a directory that is neither apps/* nor packages/*, beside a workspace one',
      should:
        'classify the outside one orphan and keep the workspace one claimed',
      actual: [
        classifyTestFile('infra/integration/x.integration.ts'),
        classifyTestFile('packages/db/integration/db.integration.ts'),
      ],
      expected: ['orphan', 'integration'],
    });
  });

  test('names workspace locations in the ORPHAN_SUITE hint, never a bare src/ or scripts/ (ISSUE-180)', () => {
    const detail = orphanSuiteDetail('infra/scripts/x.test.ts');
    assert({
      given: 'an orphan suite outside any workspace',
      should:
        'name the file and the workspace-rooted locations the gate actually claims',
      actual: {
        namesFile: detail.startsWith('infra/scripts/x.test.ts '),
        namesWorkspaceSrc: detail.includes('apps/*/src/'),
        bareSrc: /[(,] src\//.test(detail),
        bareScriptsOnlyAsRoot: /[(,] scripts\/[,)]/.test(detail),
      },
      expected: {
        namesFile: true,
        namesWorkspaceSrc: true,
        bareSrc: false,
        bareScriptsOnlyAsRoot: false,
      },
    });
  });

  test('flags TSX suites no runner globs as orphans', () => {
    assert({
      given:
        'an .e2e.tsx outside the Playwright testMatch and an .integration.tsx outside the bun test src glob',
      should: 'mark both orphans instead of counting them as claimed',
      actual: [
        'apps/web/e2e/app.e2e.tsx',
        'apps/web/src/ui/store/store.integration.tsx',
      ].map(classifyTestFile),
      expected: ['orphan', 'orphan'],
    });
  });
});

const wiredScripts = {
  test: 'bun test ./scripts && turbo run test',
  lint: 'eslint . && bun scripts/check-styling.ts && bun test eslint.config.test.ts',
  check:
    'bun run policy && bun run knip && bun run duplication && bun run invariants && bun run evidence',
};

describe('rootClaimProblems', () => {
  test('accepts a check chain that runs every root gate', () => {
    assert({
      given: 'root scripts that invoke every claimed gate',
      should: 'report nothing',
      actual: rootClaimProblems(wiredScripts),
      expected: [],
    });
  });

  test('flags a check chain that drops the duplication gate', () => {
    assert({
      given: 'a check script without the duplication gate',
      should: 'fail with UNRUN_SUITE naming the missing gate',
      actual: rootClaimProblems({
        ...wiredScripts,
        check: 'bun run policy && bun run invariants && bun run evidence',
      }),
      expected: [
        {
          code: 'UNRUN_SUITE',
          detail:
            'root "check" script does not invoke duplication; the corresponding suites would not run in bun check',
        },
      ],
    });
  });
});

// Shaped like the real ci.yml: a multi-line flow-sequence matrix driven by
// `bun run ${{ matrix.task }}`, plus a job that invokes one gate directly.
const wiredWorkflow = [
  'jobs:',
  '  checks:',
  '    strategy:',
  '      matrix:',
  '        task:',
  '          [',
  '            policy,',
  '            knip, # dead code',
  '            duplication, ',
  '            invariants,',
  '            evidence,',
  '          ]',
  '    steps:',
  '      - run: bun install --frozen-lockfile',
  '      - run: bun run ${{ matrix.task }}',
  '  migrations:',
  '    steps:',
  '      - run: bun migrations:check',
].join('\n');

describe('ciInvokedTasks', () => {
  test('reads matrix entries and direct bun invocations', () => {
    assert({
      given: 'a workflow with a multi-line matrix and a direct gate step',
      should: 'return every task CI actually invokes, without comments',
      actual: ciInvokedTasks(wiredWorkflow),
      expected: [
        'policy',
        'knip',
        'duplication',
        'invariants',
        'evidence',
        'install',
        'migrations:check',
      ],
    });
  });

  test('reads inline and block-sequence matrices', () => {
    assert({
      given: 'an inline flow matrix and a block-sequence matrix',
      should: 'extract the same entries from both shapes',
      actual: [
        ciInvokedTasks(
          'task: [knip, policy]\n- run: bun run ${{ matrix.task }}',
        ),
        ciInvokedTasks(
          'task:\n  - knip\n  - policy\nsteps:\n  - run: bun run ${{ matrix.task }}',
        ),
      ],
      expected: [
        ['knip', 'policy'],
        ['knip', 'policy'],
      ],
    });
  });

  test('ignores a matrix that no step executes', () => {
    assert({
      given: 'a task matrix without a step running matrix.task',
      should: 'count none of its entries as invoked',
      actual: ciInvokedTasks('task: [knip, policy]\nsteps:\n  - run: bun lint'),
      expected: ['lint'],
    });
  });
});

describe('ciGateProblems', () => {
  test('accepts a workflow that runs every gate', () => {
    assert({
      given: 'a ci.yml naming every required gate',
      should: 'report nothing',
      actual: ciGateProblems(wiredWorkflow),
      expected: [],
    });
  });

  test('flags a workflow that drops the duplication gate', () => {
    assert({
      given: 'a ci.yml whose matrix no longer lists duplication',
      should: 'fail with UNRUN_SUITE naming the gate',
      actual: ciGateProblems(
        wiredWorkflow.replace('            duplication, \n', ''),
      ),
      expected: [
        {
          code: 'UNRUN_SUITE',
          detail:
            'ci.yml does not run duplication; the gate would silently stop running in CI',
        },
      ],
    });
  });

  test('flags every gate when the workflow is missing', () => {
    assert({
      given: 'no ci.yml at all',
      should: 'report each required gate as unrun',
      actual: ciGateProblems(undefined).map(({ detail }) =>
        detail.replace(/^ci\.yml does not run (\S+);.*$/, '$1'),
      ),
      expected: [
        'knip',
        'policy',
        'duplication',
        'invariants',
        'evidence',
        'migrations:check',
      ],
    });
  });

  test('rejects a gate that is only mentioned in a comment', () => {
    assert({
      given: 'a matrix without duplication and a comment naming it',
      should: 'fail, because a comment runs nothing',
      actual: ciGateProblems(
        wiredWorkflow.replace(
          '            duplication, \n',
          '            # duplication, (temporarily disabled)\n',
        ),
      ).map(({ detail }) => detail),
      expected: [
        'ci.yml does not run duplication; the gate would silently stop running in CI',
      ],
    });
  });

  test('does not mistake a comment for a duplicated browser suite', () => {
    assert({
      given: 'a comment explaining that e2e.yml owns test:e2e',
      should: 'report nothing',
      actual: ciGateProblems(
        `${wiredWorkflow}\n      # bun test:e2e lives in e2e.yml`,
      ),
      expected: [],
    });
  });

  test('keeps e2e.yml the single browser-suite owner', () => {
    assert({
      given: 'a ci.yml that also runs test:e2e',
      should: 'fail with E2E_DUPLICATED',
      actual: ciGateProblems(`${wiredWorkflow}\n      - run: bun test:e2e`).map(
        ({ code }) => code,
      ),
      expected: ['E2E_DUPLICATED'],
    });
  });
});
