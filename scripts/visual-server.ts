#!/usr/bin/env bun
/**
 * `bun visual:server`: the Linux Playwright browser server that renders the
 * visual baselines on any host (docs/development/testing.md). It lives here,
 * not inline in package.json, because Bun rewrites `npx` in a package.json
 * script to `bun x`, which the Playwright image does not have (ISSUE-92).
 * The image tag and run-server version come from the web app's exact
 * @playwright/test pin (the frozen lockfile installs exactly that), so they
 * cannot drift from it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = '43400';

export const pinnedPlaywrightVersion = (): string =>
  JSON.parse(
    readFileSync(join(import.meta.dir, '../apps/web/package.json'), 'utf8'),
  ).devDependencies['@playwright/test'] as string;

/** The `docker` arguments that start the version-matched run-server. */
export const visualServerArgs = (version: string): readonly string[] => {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`unexpected Playwright version: ${version}`);
  return [
    'run',
    '--rm',
    '--init',
    '--ipc=host',
    '--name',
    'pw-visual-server',
    '-p',
    `127.0.0.1:${PORT}:3400`,
    `mcr.microsoft.com/playwright:v${version}-noble`,
    '/bin/sh',
    '-c',
    `npx -y playwright@${version} run-server --port 3400 --host 0.0.0.0`,
  ];
};

if (import.meta.main) {
  const server = Bun.spawn(
    ['docker', ...visualServerArgs(pinnedPlaywrightVersion())],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );
  process.exit(await server.exited);
}
