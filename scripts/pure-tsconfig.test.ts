import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const purePackages = ['domain', 'protocol', 'errors', 'auth'];

/** The effective compiler options and files `tsc` resolves for a project. */
const showConfig = (project: string) => {
  const result = Bun.spawnSync(['bunx', 'tsc', '-p', project, '--showConfig']);
  const config = JSON.parse(result.stdout.toString()) as {
    compilerOptions: { lib?: string[]; types?: string[] };
    files?: string[];
  };
  return {
    lib: config.compilerOptions.lib ?? [],
    types: config.compilerOptions.types ?? [],
    files: config.files ?? [],
  };
};

describe('pure package compiler settings (ISSUE-9)', () => {
  test('domain and contract sources compile without DOM or Bun ambient types', () => {
    const configs = purePackages.map((name) => {
      const { lib, types, files } = showConfig(
        `packages/${name}/tsconfig.json`,
      );
      return {
        name,
        dom: lib.some((entry) => entry.toLowerCase().startsWith('dom')),
        types,
        testFiles: files.filter((file) => file.includes('.test.')).length,
        sourceFiles: files.length > 0,
      };
    });
    assert({
      given: 'each pure package source project',
      should: 'use no DOM lib, no ambient types and no test files',
      actual: configs,
      expected: purePackages.map((name) => ({
        name,
        dom: false,
        types: [],
        testFiles: 0,
        sourceFiles: true,
      })),
    });
  }, 180_000);

  test('their tests typecheck in a separate project with Bun types', () => {
    const configs = purePackages.map((name) => {
      const { types, files } = showConfig(
        `packages/${name}/tsconfig.test.json`,
      );
      return {
        name,
        bun: types.includes('bun'),
        testFiles: files.some((file) => file.includes('.test.')),
      };
    });
    assert({
      given: 'each pure package test project',
      should: 'include the tests and the Bun types they run under',
      actual: configs,
      expected: purePackages.map((name) => ({
        name,
        bun: true,
        testFiles: true,
      })),
    });
  }, 180_000);
});
