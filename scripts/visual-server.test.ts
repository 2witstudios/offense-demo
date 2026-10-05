import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { pinnedPlaywrightVersion, visualServerArgs } from './visual-server';

setupRitewayBun();

describe('visualServerArgs', () => {
  test('runs the Playwright image matching the pinned version', () => {
    const args = visualServerArgs('1.63.0');
    assert({
      given: 'Playwright 1.63.0',
      should:
        'run the 1.63.0 noble image on 127.0.0.1:43400 and start that version of run-server inside it',
      actual: [
        args[0],
        args.includes('mcr.microsoft.com/playwright:v1.63.0-noble'),
        args.includes('127.0.0.1:43400:3400'),
        args.at(-1),
      ],
      expected: [
        'run',
        true,
        true,
        'npx -y playwright@1.63.0 run-server --port 3400 --host 0.0.0.0',
      ],
    });
  });

  test('refuses a version that is not plain semver', () => {
    assert({
      given: 'a version with shell metacharacters',
      should: 'throw rather than build a command from it',
      actual: (() => {
        try {
          visualServerArgs('1.63.0; rm -rf /');
          return 'built';
        } catch (error) {
          return (error as Error).message;
        }
      })(),
      expected: 'unexpected Playwright version: 1.63.0; rm -rf /',
    });
  });
});

describe('bun visual:server', () => {
  test('calls the script, so Bun never rewrites the in-container npx (ISSUE-92)', () => {
    const scripts = JSON.parse(
      readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
    ).scripts as Record<string, string>;
    assert({
      given: 'the root package.json',
      should: 'run scripts/visual-server.ts with no docker or npx inline',
      actual: scripts['visual:server'],
      expected: 'bun scripts/visual-server.ts',
    });
  });

  test('reads the exact version the web app pins', () => {
    const version = pinnedPlaywrightVersion();
    assert({
      given: "the web app's @playwright/test pin",
      should: 'be an exact version the server command accepts',
      actual: [
        /^\d+\.\d+\.\d+$/.test(version),
        visualServerArgs(version).includes(
          `mcr.microsoft.com/playwright:v${version}-noble`,
        ),
      ],
      expected: [true, true],
    });
  });
});
