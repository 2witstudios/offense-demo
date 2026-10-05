import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { routeExists } from './route-exists';

setupRitewayBun();

const withAppDirectory =
  (
    build: (appDirectory: string) => void,
  ): ((run: (appDirectory: string) => void) => void) =>
  (run) => {
    const appDirectory = mkdtempSync(join(tmpdir(), 'route-exists-'));
    try {
      build(appDirectory);
      run(appDirectory);
    } finally {
      rmSync(appDirectory, { recursive: true, force: true });
    }
  };

const makePage = (appDirectory: string, ...segments: string[]): void => {
  const directory = join(appDirectory, ...segments);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'page.tsx'), 'export default function P(){}');
};

describe('routeExists', () => {
  test('finds a page nested inside a transparent route group', () => {
    withAppDirectory((appDirectory) => {
      makePage(appDirectory, '(shell)', 'app');
    })((appDirectory) => {
      assert({
        given: 'a page inside a (shell) route group',
        should: 'resolve /app by treating the group as transparent',
        actual: routeExists(appDirectory, '/app'),
        expected: true,
      });
    });
  });

  test('finds the root page nested directly inside a route group', () => {
    withAppDirectory((appDirectory) => {
      makePage(appDirectory, '(shell)');
    })((appDirectory) => {
      assert({
        given: 'a page.tsx directly inside a (shell) route group',
        should: 'resolve / with no further segments',
        actual: routeExists(appDirectory, '/'),
        expected: true,
      });
    });
  });

  test('matches a dynamic segment directory', () => {
    withAppDirectory((appDirectory) => {
      makePage(appDirectory, '(shell)', 'profile', '[username]');
    })((appDirectory) => {
      assert({
        given: 'a [username] dynamic segment inside a route group',
        should: 'resolve any concrete username for that route',
        actual: routeExists(appDirectory, '/profile/ada-byron'),
        expected: true,
      });
    });
  });

  test('rejects a route with no matching page', () => {
    withAppDirectory((appDirectory) => {
      makePage(appDirectory, '(shell)', 'app');
    })((appDirectory) => {
      assert({
        given: 'an app tree with no /nowhere page',
        should: 'return false',
        actual: routeExists(appDirectory, '/nowhere'),
        expected: false,
      });
    });
  });
});
