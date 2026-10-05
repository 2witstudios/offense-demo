import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { parseBaseRef, partitionAffected, planGates } from './check-affected';

setupRitewayBun();

describe('partitionAffected', () => {
  test('scopes eslint and prettier to eligible changed files', () => {
    const plan = partitionAffected([
      'apps/web/src/features/foundation/operations.ts',
      'README.md',
      'docs/development/local-development.md',
    ]);
    assert({
      given: 'mixed code and docs changes',
      should: 'lint only code files and prettier-check all',
      actual: {
        lintFiles: plan.lintFiles,
        prettierFiles: plan.prettierFiles.length,
      },
      expected: {
        lintFiles: ['apps/web/src/features/foundation/operations.ts'],
        prettierFiles: 3,
      },
    });
  });

  test('runs turbo only when workspace files change', () => {
    assert({
      given: 'only docs changes',
      should: 'skip the turbo affected gate',
      actual: partitionAffected(['docs/development/testing.md']).runTurbo,
      expected: false,
    });
    assert({
      given: 'a package source change',
      should: 'run the turbo affected gate',
      actual: partitionAffected(['packages/protocol/src/index.ts']).runTurbo,
      expected: true,
    });
  });

  test('excludes deleted files from lint and prettier but keeps workspace selection', () => {
    const plan = partitionAffected(
      [
        'packages/protocol/src/gone.ts',
        'apps/web/src/features/kept.ts',
        'docs/removed.md',
      ],
      ['packages/protocol/src/gone.ts', 'docs/removed.md'],
    );
    assert({
      given: 'a mix of existing and deleted files',
      should: 'drop only nonexistent files from the file-based gates',
      actual: {
        lintFiles: plan.lintFiles,
        prettierFiles: plan.prettierFiles,
        runTurbo: plan.runTurbo,
      },
      expected: {
        lintFiles: ['apps/web/src/features/kept.ts'],
        prettierFiles: ['apps/web/src/features/kept.ts'],
        runTurbo: true,
      },
    });
  });

  test('root script changes run the root script tests', () => {
    assert({
      given: 'a change under scripts/',
      should: 'run the root script test suite',
      actual: partitionAffected(['scripts/doctor.ts']).runRootScriptsTests,
      expected: true,
    });
  });

  test('eslint config changes run the config tests', () => {
    assert({
      given: 'a change to eslint.config.mjs',
      should: 'run the eslint config test suite',
      actual: partitionAffected(['eslint.config.mjs']).runEslintConfigTest,
      expected: true,
    });
  });
});

describe('planGates', () => {
  test('always includes the repo-wide boundaries and duplication gates', () => {
    assert({
      given: 'no changed files',
      should: 'still verify architecture boundaries and the duplication gate',
      actual: planGates(partitionAffected([]), 'sha0'),
      expected: [
        { name: 'boundaries', args: ['bun', 'scripts/check-boundaries.ts'] },
        { name: 'styling', args: ['bun', 'scripts/check-styling.ts'] },
        { name: 'duplication', args: ['bun', 'run', 'duplication'] },
      ],
    });
  });

  test('turbo gate filters to the affected graph since the merge base', () => {
    const gates = planGates(
      partitionAffected(['packages/protocol/src/index.ts']),
      'abc123',
    );
    const turbo = gates.find(({ name }) => name.startsWith('turbo'));
    assert({
      given: 'a package change and a merge base',
      should: 'filter turbo to affected packages and dependents',
      actual: turbo?.args.slice(-2),
      expected: ['--filter', '...[abc123]'],
    });
  });

  test('deletion-only changes skip the eslint and prettier gates', () => {
    const gates = planGates(
      partitionAffected(
        ['packages/protocol/src/gone.ts'],
        ['packages/protocol/src/gone.ts'],
      ),
      'abc123',
    );
    assert({
      given: 'only a deleted workspace file',
      should: 'run the repo-wide gates and turbo without file-based gates',
      actual: gates.map(({ name }) => name),
      expected: [
        'boundaries',
        'styling',
        'duplication',
        'turbo affected (typecheck, test)',
      ],
    });
  });
});

describe('parseBaseRef', () => {
  test('defaults to origin/main when only flags are passed', () => {
    assert({
      given: 'argv containing only a --json flag',
      should: 'keep the default base ref',
      actual: parseBaseRef(['bun', 'scripts/check-affected.ts', '--json']),
      expected: 'origin/main',
    });
  });

  test('uses the first positional argument as the base ref', () => {
    assert({
      given: 'a positional ref followed by a flag',
      should: 'select the positional ref',
      actual: parseBaseRef([
        'bun',
        'scripts/check-affected.ts',
        '--json',
        'origin/develop',
      ]),
      expected: 'origin/develop',
    });
  });
});
