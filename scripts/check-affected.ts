import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

export type AffectedPlan = {
  readonly lintFiles: readonly string[];
  readonly prettierFiles: readonly string[];
  readonly runTurbo: boolean;
  readonly runRootScriptsTests: boolean;
  readonly runEslintConfigTest: boolean;
};

const eslintExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);
const prettierExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.yml',
  '.yaml',
]);

const extension = (file: string): string => file.slice(file.lastIndexOf('.'));

export const parseBaseRef = (argv: readonly string[]): string =>
  argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'origin/main';

export function partitionAffected(
  changedFiles: readonly string[],
  missingFiles: readonly string[] = [],
): AffectedPlan {
  const missing = new Set(missingFiles);
  const onDisk = (file: string) => !missing.has(file);
  const inWorkspace = (file: string) =>
    file.startsWith('apps/') || file.startsWith('packages/');
  return {
    lintFiles: changedFiles.filter(
      (file) => onDisk(file) && eslintExtensions.has(extension(file)),
    ),
    prettierFiles: changedFiles.filter(
      (file) => onDisk(file) && prettierExtensions.has(extension(file)),
    ),
    runTurbo: changedFiles.some(inWorkspace),
    runRootScriptsTests: changedFiles.some(
      (file) => file.startsWith('scripts/') || file === 'eslint.config.test.ts',
    ),
    runEslintConfigTest: changedFiles.some((file) =>
      file.startsWith('eslint.config'),
    ),
  };
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} failed (exit ${exitCode}); fetch the base ref first (git fetch origin)`,
    );
  return stdout.trim();
}

const nonEmptyLines = (output: string): readonly string[] =>
  output.length === 0 ? [] : output.split('\n');

export async function collectChangedFiles(
  mergeBase: string,
): Promise<readonly string[]> {
  const [committed, working, untracked] = await Promise.all([
    gitOutput(['diff', '--name-only', mergeBase]),
    gitOutput(['diff', '--name-only', 'HEAD']),
    gitOutput(['ls-files', '--others', '--exclude-standard']),
  ]);
  return [
    ...new Set([
      ...nonEmptyLines(committed),
      ...nonEmptyLines(working),
      ...nonEmptyLines(untracked),
    ]),
  ].sort();
}

type Gate = { readonly name: string; readonly args: readonly string[] };

export function planGates(
  plan: AffectedPlan,
  mergeBase: string,
): readonly Gate[] {
  const gates: Gate[] = [];
  if (plan.lintFiles.length > 0)
    gates.push({
      name: 'eslint (changed files)',
      args: ['bunx', '--bun', 'eslint', ...plan.lintFiles],
    });
  if (plan.prettierFiles.length > 0)
    gates.push({
      name: 'prettier (changed files)',
      args: ['bunx', 'prettier', '--check', ...plan.prettierFiles],
    });
  gates.push({
    name: 'boundaries',
    args: ['bun', 'scripts/check-boundaries.ts'],
  });
  gates.push({ name: 'styling', args: ['bun', 'scripts/check-styling.ts'] });
  // Repo-wide by nature and ~0.05s: a clone is only visible against the whole
  // tree, so the tripwire runs on every push (ADR 0026).
  gates.push({ name: 'duplication', args: ['bun', 'run', 'duplication'] });
  if (plan.runRootScriptsTests)
    gates.push({
      name: 'root script tests',
      args: ['bun', 'test', './scripts'],
    });
  if (plan.runEslintConfigTest)
    gates.push({
      name: 'eslint config tests',
      // As in the lint script: the 5 s default times out on a loaded machine.
      args: ['bun', 'test', '--timeout', '180000', 'eslint.config.test.ts'],
    });
  if (plan.runTurbo)
    gates.push({
      name: 'turbo affected (typecheck, test)',
      args: [
        'bunx',
        '--bun',
        'turbo',
        'run',
        'typecheck',
        'test',
        '--filter',
        `...[${mergeBase}]`,
      ],
    });
  return gates;
}

export function formatAffectedReport(
  changedFiles: readonly string[],
  results: readonly { readonly name: string; readonly ok: boolean }[],
  json: boolean,
): string {
  if (json)
    return `${JSON.stringify({ ok: results.every(({ ok }) => ok), changedFiles, gates: results }, null, 2)}\n`;
  return [
    `Offense Demo check:affected — ${changedFiles.length} changed file${changedFiles.length === 1 ? '' : 's'}`,
    ...results.map(({ name, ok }) => `${ok ? 'PASS' : 'FAIL'} ${name}`),
    'bun check remains the pre-push gate; this loop skips knip, metrics, and build.',
    '',
  ].join('\n');
}

async function runGate(gate: Gate): Promise<boolean> {
  const child = Bun.spawn(gate.args, {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return (await child.exited) === 0;
}

if (import.meta.main) {
  try {
    const mergeBase = await gitOutput([
      'merge-base',
      'HEAD',
      parseBaseRef(process.argv),
    ]);
    const changedFiles = await collectChangedFiles(mergeBase);
    const results: { name: string; ok: boolean }[] = [];
    if (changedFiles.length === 0) {
      results.push({ name: 'no changes since base', ok: true });
    } else {
      const missingFiles = changedFiles.filter(
        (file) => !existsSync(resolve(root, file)),
      );
      for (const gate of planGates(
        partitionAffected(changedFiles, missingFiles),
        mergeBase,
      ))
        results.push({ name: gate.name, ok: await runGate(gate) });
    }
    process.stdout.write(
      formatAffectedReport(
        changedFiles,
        results,
        process.argv.includes('--json'),
      ),
    );
    process.exitCode = results.every(({ ok }) => ok) ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'check:affected failed'}\n`,
    );
    process.exitCode = 1;
  }
}
