import { resolve } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

import { deadScanRoots, scanRootPatterns } from './duplication-config';

setupRitewayBun();

describe('scanRootPatterns', () => {
  test('expands the brace alternation into one glob per scan root', () => {
    assert({
      given: 'a jscpd pattern with several braced roots',
      should: 'return each root joined to the shared suffix',
      actual: scanRootPatterns('{apps/*/src,scripts}/**/*'),
      expected: ['apps/*/src/**/*', 'scripts/**/*'],
    });
    assert({
      given: 'a pattern without braces',
      should: 'return it as the single scan root',
      actual: scanRootPatterns('scripts/**/*'),
      expected: ['scripts/**/*'],
    });
  });
});

describe('deadScanRoots', () => {
  const config = {
    pattern: '{apps/*/src,scripts}/**/*',
    ignore: ['**/*.test.ts'],
  };

  test('accepts roots that each match a scannable tracked file', () => {
    assert({
      given: 'tracked source under every scan root',
      should: 'report no dead roots',
      actual: deadScanRoots(config, [
        'apps/web/src/proxy.ts',
        'scripts/policy.ts',
      ]),
      expected: [],
    });
  });

  test('flags a root whose directory was renamed away', () => {
    assert({
      given: 'no tracked file under scripts/',
      should: 'name the dead root so the rename fails loudly',
      actual: deadScanRoots(config, ['apps/web/src/proxy.ts', 'tools/x.ts']),
      expected: ['scripts/**/*'],
    });
  });

  test('does not count ignored or non-source files as coverage', () => {
    assert({
      given: 'a root holding only an ignored suite and a markdown file',
      should: 'still report the root as dead',
      actual: deadScanRoots(config, [
        'apps/web/src/proxy.ts',
        'scripts/policy.test.ts',
        'scripts/README.md',
      ]),
      expected: ['scripts/**/*'],
    });
  });
});

describe.each(['.jscpd.json', '.jscpd-tests.json'])('%s', (config) => {
  test('every scan root matches tracked source', async () => {
    const root = resolve(import.meta.dir, '..');
    const committed = (await Bun.file(resolve(root, config)).json()) as {
      pattern: string;
      ignore: readonly string[];
    };
    const tracked = (await Bun.$`git ls-files`.cwd(root).text())
      .split('\n')
      .filter(Boolean);
    assert({
      given: `the committed ${config} and the tracked tree`,
      should: 'leave no scan root matching zero scannable files',
      actual: deadScanRoots(committed, tracked),
      expected: [],
    });
  });
});
