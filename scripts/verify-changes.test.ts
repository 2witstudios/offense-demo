import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { gitChangedFiles, isDocsOnly } from './verify';

setupRitewayBun();

// Inside a git hook GIT_DIR points at the real repository: never inherit it,
// or these commands would commit into the checkout running the tests.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(['git', ...args], {
    cwd,
    env: cleanEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

describe('verify: the files a branch changes', () => {
  test('lists a renamed code file by its old path too, and untracked files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'grd-6-verify-git-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.invalid');
    git(repo, 'config', 'user.name', 't');
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'scripts/a.ts'), 'export const a = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').stdout.toString().trim();
    git(repo, 'mv', 'scripts/a.ts', 'docs/a.md');
    git(repo, 'commit', '-q', '-m', 'rename');
    writeFileSync(join(repo, 'docs/new.md'), '# new\n');
    // A hook's GIT_DIR must not redirect the lookup to another repository.
    const files = await gitChangedFiles(repo, base, {
      ...cleanEnv,
      GIT_DIR: '/nonexistent/.git',
    });
    assert({
      given: 'git mv scripts/a.ts docs/a.md and an untracked docs/new.md',
      should:
        'list scripts/a.ts, docs/a.md and docs/new.md, so the diff is not docs-only',
      actual: [[...files].sort(), isDocsOnly(files)],
      expected: [['docs/a.md', 'docs/new.md', 'scripts/a.ts'], false],
    });
  });
});
