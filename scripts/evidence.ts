import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { claimsIntegrationSuite } from './test-integration';

const root = resolve(import.meta.dir, '..');
const skipDirectories = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.pu',
  'dist',
  'test-results',
  'playwright-report',
]);

export type TestTier =
  | 'unit'
  | 'workspace-script'
  | 'root-script'
  | 'root-config'
  | 'integration'
  | 'e2e'
  | 'orphan';

export type EvidenceProblemCode =
  'ORPHAN_SUITE' | 'UNRUN_SUITE' | 'GUARD_MISSING' | 'E2E_DUPLICATED';

export type EvidenceProblem = {
  readonly code: EvidenceProblemCode;
  readonly detail: string;
};

export type EvidenceReport = {
  readonly ok: boolean;
  readonly claimed: Readonly<Record<Exclude<TestTier, 'orphan'>, number>>;
  readonly problems: readonly EvidenceProblem[];
};

// Every suite-shaped name is visible to the gate, TSX included, so a file no
// runner executes surfaces as an orphan instead of vanishing from the audit.
const testFilePattern = /\.(test|integration|e2e)\.tsx?$/;

export function isTestFilePath(relativePath: string): boolean {
  return testFilePattern.test(relativePath);
}

export function classifyTestFile(relativePath: string): TestTier {
  // `bun test <dir>` globs *.test.ts and *.test.tsx alike.
  if (/^scripts\/.+\.test\.tsx?$/.test(relativePath)) return 'root-script';
  // The template initializer's and npm bootstrapper's own suites
  // (`bun test ./cli` and `bun test ./create` in the root "test" script);
  // generated projects delete cli/ and create/ together with those runs.
  if (/^(cli|create)\/.+\.test\.tsx?$/.test(relativePath)) return 'root-script';
  if (relativePath === 'eslint.config.test.ts') return 'root-config';
  if (/^(apps|packages)\/[^/]+\/integration\//.test(relativePath))
    return 'integration';
  if (
    relativePath.startsWith('apps/web/e2e/') &&
    relativePath.endsWith('.e2e.ts')
  )
    return 'e2e';
  // `bun test src` globs only *.test.ts(x). An .integration or .e2e suffix
  // under src/, and any .integration.tsx or .e2e.tsx (Playwright's testMatch
  // is **/*.e2e.ts), is executed by no runner and falls through to orphan,
  // as does a src/, scripts/ or integration/ suite outside a workspace
  // (apps/*, packages/*): no workspace runner reaches it (ISSUE-171,
  // ISSUE-180).
  if (/^(apps|packages)\/[^/]+\/src\/.+\.test\.tsx?$/.test(relativePath))
    return 'unit';
  // A workspace's own operational scripts (e.g. apps/web/scripts/auth-load),
  // never the top-level scripts/ folder (already matched above): claimed by
  // widening that workspace's "test" script to "bun test src scripts".
  if (/^(apps|packages)\/[^/]+\/scripts\/.+\.test\.tsx?$/.test(relativePath))
    return 'workspace-script';
  return 'orphan';
}

/** The ORPHAN_SUITE message: the file and the locations the gate claims. */
export function orphanSuiteDetail(file: string): string {
  return `${file} is not claimed by any runner; move it under a claimed location (apps/*/src/, packages/*/src/, apps/*/scripts/, packages/*/scripts/, apps/*/integration/, packages/*/integration/, the root scripts/, apps/web/e2e/)`;
}

export const TEST_SERVICES_GUARD = {
  module: '@offense-demo/config',
  name: 'requireTestServices',
} as const;

// The local names a suite binds to the shared guard's import.
const guardBindings = (source: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== TEST_SERVICES_GUARD.module
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      if (
        (element.propertyName ?? element.name).text === TEST_SERVICES_GUARD.name
      )
        names.add(element.name.text);
  }
  return names;
};

// `guard(process.env)`: the imported guard called directly (no optional
// chaining) on the process environment, nothing else.
const isGuardCall = (
  node: ts.Node | undefined,
  names: ReadonlySet<string>,
): boolean =>
  node !== undefined &&
  ts.isCallExpression(node) &&
  node.questionDotToken === undefined &&
  ts.isIdentifier(node.expression) &&
  names.has(node.expression.text) &&
  node.arguments.length === 1 &&
  node.arguments[0]!.getText() === 'process.env';

// Whether the guard runs unconditionally when the module loads: a top-level
// `guard(process.env);` statement or a `const … = guard(process.env);`
// declaration. Anything under an `if`, a `try`, a short-circuit or a block
// may never run, so it does not count.
const callsAtLoad = (source: ts.SourceFile, names: ReadonlySet<string>) =>
  source.statements.some(
    (statement) =>
      (ts.isExpressionStatement(statement) &&
        isGuardCall(statement.expression, names)) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1 &&
        isGuardCall(
          statement.declarationList.declarations[0]!.initializer,
          names,
        )),
  );

// A suite that nothing invokes is indistinguishable from a suite that does
// not exist (PageSpace lesson): every integration suite imports the one
// shared guard and calls it at load, so a missing test service fails the
// file instead of silently passing an empty run. Checked on the parsed
// import graph, never on text a comment or a copied guard could satisfy.
export function integrationGuardProblems(
  content: string,
  relativePath: string,
): readonly EvidenceProblem[] {
  const source = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (callsAtLoad(source, guardBindings(source))) return [];
  return [
    {
      code: 'GUARD_MISSING',
      detail: `${relativePath} must import ${TEST_SERVICES_GUARD.name} from ${TEST_SERVICES_GUARD.module} and call it on process.env in a top-level statement (it throws on a missing service; never skip)`,
    },
  ];
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function listTestFiles(
  directory: string,
  prefix = '',
): Promise<readonly string[]> {
  const entries = await readdir(join(root, directory, prefix), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue;
      files.push(...(await listTestFiles(directory, relativePath)));
    } else if (entry.isFile() && isTestFilePath(relativePath))
      files.push(relativePath);
  }
  return files;
}

async function workspaceDirectories(): Promise<readonly string[]> {
  const manifest = await readJson(join(root, 'package.json'));
  const patterns = (manifest.workspaces ?? []) as readonly string[];
  const directories: string[] = [];
  for (const pattern of patterns) {
    const base = pattern.replace(/\/\*$/, '');
    try {
      if (!(await stat(join(root, base))).isDirectory()) continue;
      for (const entry of await readdir(join(root, base), {
        withFileTypes: true,
      }))
        if (entry.isDirectory()) directories.push(`${base}/${entry.name}`);
    } catch {
      // A declared workspace root that does not exist is not a suite problem.
    }
  }
  return directories;
}

type ScriptMap = Readonly<Record<string, string>>;

const readScripts = async (path: string): Promise<ScriptMap> => {
  const manifest = await readJson(path);
  return (manifest.scripts ?? {}) as ScriptMap;
};

export const rootClaimProblems = (
  scripts: ScriptMap,
): readonly EvidenceProblem[] => {
  const problems: EvidenceProblem[] = [];
  const claims: readonly [string, string][] = [
    ['test', 'bun test ./scripts'],
    ['lint', 'eslint.config.test.ts'],
    ['lint', 'scripts/check-styling.ts'],
    ['check', 'policy'],
    ['check', 'duplication'],
    ['check', 'invariants'],
    ['check', 'evidence'],
  ];
  for (const [script, needle] of claims)
    if (!(scripts[script] ?? '').includes(needle))
      problems.push({
        code: 'UNRUN_SUITE',
        detail: `root "${script}" script does not invoke ${needle}; the corresponding suites would not run in bun check`,
      });
  return problems;
};

const workspaceClaimProblems = async (
  byWorkspace: ReadonlyMap<
    string,
    { unit: string[]; workspaceScript: string[]; integration: string[] }
  >,
): Promise<readonly EvidenceProblem[]> => {
  const problems: EvidenceProblem[] = [];
  for (const [workspace, bucket] of byWorkspace) {
    const scripts = await readScripts(join(root, workspace, 'package.json'));
    const requiredTestScript =
      bucket.workspaceScript.length > 0
        ? 'bun test src scripts'
        : 'bun test src';
    if (
      (bucket.unit.length > 0 || bucket.workspaceScript.length > 0) &&
      scripts.test !== requiredTestScript
    )
      problems.push({
        code: 'UNRUN_SUITE',
        detail: `${workspace} has ${bucket.workspaceScript.length > 0 ? 'src/scripts' : 'src'} suites but its "test" script is not "${requiredTestScript}"`,
      });
    for (const file of bucket.integration) {
      if (!claimsIntegrationSuite(scripts['test:integration'] ?? '', file))
        problems.push({
          code: 'UNRUN_SUITE',
          detail: `${workspace} "test:integration" does not invoke ${file}`,
        });
      const content = await readFile(join(root, file), 'utf8');
      problems.push(...integrationGuardProblems(content, file));
    }
  }
  return problems;
};

const e2eClaimProblems = async (
  e2eCount: number,
): Promise<readonly EvidenceProblem[]> => {
  if (e2eCount === 0) return [];
  const problems: EvidenceProblem[] = [];
  const webScripts = await readScripts(join(root, 'apps/web/package.json'));
  if (!webScripts['test:e2e']?.includes('@playwright/test/cli.js'))
    problems.push({
      code: 'UNRUN_SUITE',
      detail:
        'apps/web e2e suites exist but "test:e2e" no longer drives Playwright',
    });
  const e2eWorkflow = await readTextIfExists(
    join(root, '.github/workflows/e2e.yml'),
  );
  if (!e2eWorkflow?.includes('test:e2e'))
    problems.push({
      code: 'UNRUN_SUITE',
      detail:
        'no workflow invokes test:e2e; the browser tier would silently stop running in CI',
    });
  return problems;
};

// Structural, not textual: a gate named only in a YAML comment runs nothing.
// The repo has no YAML dependency, so this reads the two shapes ci.yml uses —
// the `task` matrix (flow or block sequence) and `run: bun [run] <task>`
// steps — after dropping comments. Matrix entries count only when some step
// executes `${{ matrix.task }}`.
const flowMatrix = /^[ \t]*task:\s*\[([^\]]*)\]/m;
const blockMatrix =
  /^[ \t]*task:[ \t]*\n((?:[ \t]*-[ \t]+\S+[ \t]*(?:\n|$))+)/m;
const runStep = /^[ \t]*(?:-[ \t]+)?run:[ \t]*bun[ \t]+(?:run[ \t]+)?(\S+)/;

const matrixTasks = (workflow: string): readonly string[] => {
  const flow = flowMatrix.exec(workflow)?.[1];
  if (flow !== undefined) return flow.split(',').map((entry) => entry.trim());
  const block = blockMatrix.exec(workflow)?.[1] ?? '';
  return block.split('\n').map((entry) => entry.replace(/^\s*-\s+/, '').trim());
};

export const ciInvokedTasks = (ciWorkflow: string): readonly string[] => {
  const lines = ciWorkflow
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''));
  const steps = lines
    .map((line) => runStep.exec(line)?.[1])
    .filter((task): task is string => task !== undefined);
  const runsMatrix = steps.some((task) => task.startsWith('${{'));
  return [
    ...(runsMatrix ? matrixTasks(lines.join('\n')) : []),
    ...steps.filter((task) => !task.startsWith('${{')),
  ].filter((task) => task !== '');
};

export const ciGateProblems = (
  ciWorkflow: string | undefined,
): readonly EvidenceProblem[] => {
  const problems: EvidenceProblem[] = [];
  const invoked = new Set(ciInvokedTasks(ciWorkflow ?? ''));
  if (invoked.has('test:e2e'))
    problems.push({
      code: 'E2E_DUPLICATED',
      detail: 'ci.yml runs the browser suite; e2e.yml is the single E2E owner',
    });
  for (const gate of [
    'knip',
    'policy',
    'duplication',
    'invariants',
    'evidence',
    'migrations:check',
  ])
    if (!invoked.has(gate))
      problems.push({
        code: 'UNRUN_SUITE',
        detail: `ci.yml does not run ${gate}; the gate would silently stop running in CI`,
      });
  return problems;
};

export async function collectEvidence(): Promise<EvidenceReport> {
  const testFiles = [...(await listTestFiles('.'))].sort();
  const classified = testFiles.map((file) => ({
    file,
    tier: classifyTestFile(file),
  }));
  const tiers = {
    unit: 0,
    'workspace-script': 0,
    'root-script': 0,
    'root-config': 0,
    integration: 0,
    e2e: 0,
  };
  const orphanProblems: EvidenceProblem[] = [];
  for (const { file, tier } of classified) {
    if (tier === 'orphan')
      orphanProblems.push({
        code: 'ORPHAN_SUITE',
        detail: orphanSuiteDetail(file),
      });
    else tiers[tier] += 1;
  }

  const workspaces = await workspaceDirectories();
  const byWorkspace = new Map<
    string,
    { unit: string[]; workspaceScript: string[]; integration: string[] }
  >(
    workspaces.map((name) => [
      name,
      { unit: [], workspaceScript: [], integration: [] },
    ]),
  );
  for (const { file, tier } of classified) {
    if (tier === 'orphan') continue;
    const workspace = workspaces.find((name) => file.startsWith(`${name}/`));
    const bucket = byWorkspace.get(workspace ?? '');
    if (!bucket) continue;
    if (tier === 'unit') bucket.unit.push(file);
    if (tier === 'workspace-script') bucket.workspaceScript.push(file);
    if (tier === 'integration') bucket.integration.push(file);
  }

  const problems: EvidenceProblem[] = [
    ...orphanProblems,
    ...rootClaimProblems(await readScripts(join(root, 'package.json'))),
    ...(await workspaceClaimProblems(byWorkspace)),
    ...(await e2eClaimProblems(tiers.e2e)),
    ...ciGateProblems(
      await readTextIfExists(join(root, '.github/workflows/ci.yml')),
    ),
  ];
  return {
    ok: problems.length === 0,
    claimed: tiers,
    problems,
  };
}

export function formatEvidenceReport(
  report: EvidenceReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const counts = Object.entries(report.claimed)
    .map(([tier, count]) => `${tier}:${count}`)
    .join(' ');
  return [
    `Offense Demo evidence: ${report.ok ? 'PASS' : 'FAIL'} (${counts})`,
    ...report.problems.map(({ code, detail }) => `  ${code}: ${detail}`),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const report = await collectEvidence();
  process.stdout.write(
    formatEvidenceReport(report, process.argv.includes('--json')),
  );
  process.exitCode = report.ok ? 0 : 1;
}
