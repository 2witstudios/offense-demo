import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { resolve, dirname } from 'node:path';
import type { BunPlugin } from 'bun';
import { authClient } from './auth-client';

setupRitewayBun();

const entrypoint = resolve(import.meta.dir, 'auth-client.ts');

const scanImportGraph = async (): Promise<{
  built: boolean;
  modules: readonly string[];
}> => {
  const modules = new Set<string>();
  const scanner: BunPlugin = {
    name: 'auth-client-import-graph',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const specifier = args.path;
        if (specifier.startsWith('node:')) {
          modules.add(specifier);
          return undefined;
        }
        try {
          modules.add(
            resolveSyncOrRaw(specifier, dirname(args.importer ?? entrypoint)),
          );
        } catch {
          modules.add(specifier);
        }
        return undefined;
      });
    },
  };
  try {
    await Bun.build({
      entrypoints: [entrypoint],
      target: 'browser',
      plugins: [scanner],
    });
  } catch {
    return { built: false, modules: [...modules] };
  }
  return { built: true, modules: [...modules] };
};

const resolveSyncOrRaw = (specifier: string, from: string): string => {
  if (specifier.startsWith('.'))
    return resolve(from, specifier).replace(/\.tsx?$/, '.ts');
  try {
    return Bun.resolveSync(specifier, from);
  } catch {
    return specifier;
  }
};

const FORBIDDEN_GRAPH_FRAGMENTS = [
  'packages/config',
  'features/auth',
  'server/app.ts',
  'server/process-app.ts',
  'node_modules/better-auth/dist/index',
  'node_modules/@better-auth/passkey/dist/index',
];

describe('auth client entrypoint', () => {
  test('exposes the passkey plugin client', () => {
    assert({
      given: 'the reserved client entrypoint',
      should: 'expose the passkey client for sign-in and enrollment',
      actual: {
        passkey: typeof authClient.signIn?.passkey,
        addPasskey: typeof authClient.passkey?.addPasskey,
      },
      expected: { passkey: 'function', addPasskey: 'function' },
    });
  });

  test('keeps server configuration and secrets outside its import graph', async () => {
    const { built, modules } = await scanImportGraph();
    const violations = modules.filter((module) =>
      FORBIDDEN_GRAPH_FRAGMENTS.some((fragment) => module.includes(fragment)),
    );
    const nodeBuiltins = modules.filter((module) => module.startsWith('node:'));
    assert({
      given: 'the client entrypoint module graph',
      should:
        'build for the browser without server composition or node builtins',
      actual: { built, violations, nodeBuiltins },
      expected: { built: true, violations: [], nodeBuiltins: [] },
    });
  });

  test('imports with no credentials in the environment', async () => {
    const strippedEnv = { NODE_ENV: process.env.NODE_ENV ?? 'test' };
    const probe = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        'await import("./src/lib/auth-client.ts"); console.log("imported")',
      ],
      { cwd: resolve(import.meta.dir, '../..'), env: strippedEnv },
    );
    const output = probe.stdout.toString().trim();
    assert({
      given: 'a subprocess environment stripped of every auth variable',
      should: 'import the client entrypoint without any credential or service',
      actual: {
        imported: output === 'imported',
        failed: probe.exitCode !== 0,
      },
      expected: { imported: true, failed: false },
    });
  });
});
