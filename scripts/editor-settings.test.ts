import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const root = new URL('..', import.meta.url).pathname;
const settings = (await Bun.file(`${root}.vscode/settings.json`).json()) as {
  'files.watcherExclude': Record<string, boolean>;
  'search.exclude': Record<string, boolean>;
  'files.exclude': Record<string, boolean>;
  'typescript.tsserver.watchOptions': { excludeDirectories: string[] };
};

describe('committed editor settings', () => {
  test('keep other checkouts out of watching, search and TypeScript discovery', () => {
    assert({
      given: 'the VS Code and Cursor workspace settings',
      should:
        'exclude .pu/worktrees and node_modules from the watcher, search and tsserver, and hide worktrees',
      actual: [
        settings['files.watcherExclude']['**/.pu/worktrees/**'],
        settings['files.watcherExclude']['**/node_modules/**'],
        settings['search.exclude']['**/.pu/worktrees'],
        settings['search.exclude']['**/node_modules'],
        settings['files.exclude']['**/.pu/worktrees'],
        settings['typescript.tsserver.watchOptions'].excludeDirectories,
      ],
      expected: [
        true,
        true,
        true,
        true,
        true,
        ['**/.pu/worktrees', '**/node_modules'],
      ],
    });
  });
});
