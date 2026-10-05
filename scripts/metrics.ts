import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

type Coverage = {
  readonly lines: number | null;
  readonly functions: number | null;
};

type PackageMetrics = {
  readonly name: string;
  readonly path: string;
  readonly sourceFiles: number;
  readonly sourceLoc: number;
  readonly testFiles: number;
  readonly testLoc: number;
  readonly functions: number;
  readonly maxComplexity: number;
  readonly meanComplexity: number;
  readonly coverage: Coverage;
  readonly churnCommits: number | null;
};

type Hotspot = {
  readonly file: string;
  readonly loc: number;
  readonly churn: number | null;
  readonly complexity: number;
  readonly score: number | null;
};

type MetricsSnapshot = {
  readonly capturedAt: string;
  readonly gitCommit: string | null;
  readonly churnWindowDays: number;
  readonly totals: {
    readonly sourceFiles: number;
    readonly sourceLoc: number;
    readonly testFiles: number;
    readonly testLoc: number;
    readonly functions: number;
    readonly maxComplexity: number;
  };
  readonly packages: readonly PackageMetrics[];
  readonly hotspots: readonly Hotspot[];
};

type Policy = {
  readonly coverage: Record<
    string,
    { readonly lines: number; readonly functions: number }
  >;
};

type FileMetrics = {
  readonly path: string;
  readonly loc: number;
  readonly isTest: boolean;
  readonly complexities: readonly number[];
};

type Churn = Map<string, ReadonlySet<string>>;

const root = resolve(import.meta.dir, '..');
const churnWindowDays = 90;
const sourceGlob = new Bun.Glob('src/**/*.{ts,tsx}');

const isFunctionLike = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node);

const isDecisionOperator = (kind: ts.SyntaxKind): boolean =>
  kind === ts.SyntaxKind.AmpersandAmpersandToken ||
  kind === ts.SyntaxKind.BarBarToken ||
  kind === ts.SyntaxKind.QuestionQuestionToken ||
  kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
  kind === ts.SyntaxKind.BarBarEqualsToken ||
  kind === ts.SyntaxKind.QuestionQuestionEqualsToken;

function calculateComplexity(node: ts.Node): number {
  let complexity = 1;
  const visit = (child: ts.Node) => {
    if (child !== node && isFunctionLike(child)) return;
    if (
      ts.isIfStatement(child) ||
      ts.isForStatement(child) ||
      ts.isForInStatement(child) ||
      ts.isForOfStatement(child) ||
      ts.isWhileStatement(child) ||
      ts.isDoStatement(child) ||
      ts.isCatchClause(child) ||
      ts.isConditionalExpression(child) ||
      (ts.isCaseClause(child) && child.expression !== undefined)
    )
      complexity += 1;
    if (
      ts.isBinaryExpression(child) &&
      isDecisionOperator(child.operatorToken.kind)
    )
      complexity += 1;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return complexity;
}

async function collectFileMetrics(path: string): Promise<FileMetrics> {
  const text = await readFile(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const complexities: number[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node)) complexities.push(calculateComplexity(node));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    path,
    loc: text.split('\n').filter((line) => line.trim()).length,
    isTest: /(?:^|\.)test\.[jt]sx?$/.test(path),
    complexities,
  };
}

async function listWorkspaces() {
  const paths = [
    ...(await Array.fromAsync(
      new Bun.Glob('packages/*/package.json').scan({ cwd: root }),
    )),
    ...(await Array.fromAsync(
      new Bun.Glob('apps/*/package.json').scan({ cwd: root }),
    )),
  ].sort();
  return Promise.all(
    paths.map(async (manifestPath) => ({
      path: manifestPath.replace(/\/package\.json$/, ''),
      manifest: JSON.parse(
        await readFile(join(root, manifestPath), 'utf8'),
      ) as {
        name: string;
        scripts?: { test?: string };
      },
    })),
  );
}

async function collectWorkspaceFiles(workspacePath: string) {
  const paths = (
    await Array.fromAsync(
      sourceGlob.scan({ cwd: join(root, workspacePath), absolute: true }),
    )
  ).sort();
  return Promise.all(paths.map(collectFileMetrics));
}

function parseLcov(text: string, workspaceRoot: string): Coverage {
  let currentFile: string | null = null;
  let linesFound = 0;
  let linesHit = 0;
  let functionsFound = 0;
  let functionsHit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const path = line.slice(3);
      currentFile = path.startsWith('/') ? path : resolve(workspaceRoot, path);
    }
    if (!currentFile || !currentFile.startsWith(`${workspaceRoot}/`)) continue;
    if (line.startsWith('LF:')) linesFound += Number(line.slice(3));
    if (line.startsWith('LH:')) linesHit += Number(line.slice(3));
    if (line.startsWith('FNF:')) functionsFound += Number(line.slice(4));
    if (line.startsWith('FNH:')) functionsHit += Number(line.slice(4));
  }
  return {
    lines: linesFound ? (linesHit / linesFound) * 100 : null,
    functions: functionsFound ? (functionsHit / functionsFound) * 100 : null,
  };
}

async function collectCoverage(
  workspacePath: string,
  hasTests: boolean,
): Promise<Coverage> {
  if (!hasTests) return { lines: null, functions: null };
  const directory = await mkdtemp(join(tmpdir(), 'offense-demo-metrics-'));
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        'test',
        'src',
        '--coverage',
        '--coverage-reporter=lcov',
        `--coverage-dir=${directory}`,
      ],
      { cwd: join(root, workspacePath), stdout: 'ignore', stderr: 'pipe' },
    );
    if (result.exitCode !== 0)
      throw new Error(
        `Coverage test failed for ${workspacePath}: ${Buffer.from(result.stderr).toString()}`,
      );
    return parseLcov(
      await readFile(join(directory, 'lcov.info'), 'utf8'),
      join(root, workspacePath),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collectChurn(): Promise<Churn> {
  const result = Bun.spawnSync(
    [
      'git',
      'log',
      `--since=${churnWindowDays}.days`,
      '--format=%H',
      '--name-only',
      '--',
      'apps',
      'packages',
    ],
    { cwd: root, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) return new Map();
  const commits = new Map<string, Set<string>>();
  let commit: string | null = null;
  for (const line of Buffer.from(result.stdout).toString().split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      commit = line;
      continue;
    }
    if (!commit || !line) continue;
    const paths = commits.get(line) ?? new Set<string>();
    paths.add(commit);
    commits.set(line, paths);
  }
  return commits;
}

async function createSnapshot(): Promise<MetricsSnapshot> {
  const workspaces = await listWorkspaces();
  const churn = await collectChurn();
  const packageMetrics = await Promise.all(
    workspaces.map(async ({ path, manifest }) => {
      const files = await collectWorkspaceFiles(path);
      const source = files.filter(({ isTest }) => !isTest);
      const tests = files.filter(({ isTest }) => isTest);
      const complexities = files.flatMap(({ complexities: values }) => values);
      const coverage = await collectCoverage(
        path,
        Boolean(manifest.scripts?.test),
      );
      const packageChurn = new Set(
        files.flatMap(({ path: filePath }) => [
          ...(churn.get(relative(root, filePath)) ?? []),
        ]),
      ).size;
      return {
        name: manifest.name,
        path,
        sourceFiles: source.length,
        sourceLoc: source.reduce((total, file) => total + file.loc, 0),
        testFiles: tests.length,
        testLoc: tests.reduce((total, file) => total + file.loc, 0),
        functions: complexities.length,
        maxComplexity: Math.max(0, ...complexities),
        meanComplexity: complexities.length
          ? complexities.reduce((total, value) => total + value, 0) /
            complexities.length
          : 0,
        coverage,
        churnCommits: packageChurn || null,
      } satisfies PackageMetrics;
    }),
  );
  const files = (
    await Promise.all(workspaces.map(({ path }) => collectWorkspaceFiles(path)))
  ).flat();
  const hotspots = files
    .map((file) => {
      const relativePath = relative(root, file.path);
      const fileChurn = churn.get(relativePath)?.size ?? 0;
      const complexity = Math.max(0, ...file.complexities);
      return {
        file: relativePath,
        loc: file.loc,
        churn: fileChurn || null,
        complexity,
        score: fileChurn ? file.loc * fileChurn * complexity : null,
      } satisfies Hotspot;
    })
    .filter(({ score }) => score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);
  return {
    capturedAt: new Date().toISOString(),
    gitCommit: await gitCommit(),
    churnWindowDays,
    totals: {
      sourceFiles: packageMetrics.reduce(
        (total, item) => total + item.sourceFiles,
        0,
      ),
      sourceLoc: packageMetrics.reduce(
        (total, item) => total + item.sourceLoc,
        0,
      ),
      testFiles: packageMetrics.reduce(
        (total, item) => total + item.testFiles,
        0,
      ),
      testLoc: packageMetrics.reduce((total, item) => total + item.testLoc, 0),
      functions: packageMetrics.reduce(
        (total, item) => total + item.functions,
        0,
      ),
      maxComplexity: Math.max(
        ...packageMetrics.map((item) => item.maxComplexity),
      ),
    },
    packages: packageMetrics,
    hotspots,
  };
}

async function gitCommit(): Promise<string | null> {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.exitCode === 0
    ? Buffer.from(result.stdout).toString().trim()
    : null;
}

async function readPolicy(): Promise<Policy> {
  return JSON.parse(
    await readFile(join(root, 'docs/metrics/policy.json'), 'utf8'),
  ) as Policy;
}

function checkPolicy(snapshot: MetricsSnapshot, policy: Policy): string[] {
  return Object.entries(policy.coverage).flatMap(([name, floor]) => {
    const metrics = snapshot.packages.find((item) => item.name === name);
    if (!metrics) return [`${name}: package missing from snapshot`];
    return [
      ...(metrics.coverage.lines === null ||
      metrics.coverage.lines < floor.lines
        ? [`${name}: lines ${metrics.coverage.lines ?? 'n/a'} < ${floor.lines}`]
        : []),
      ...(metrics.coverage.functions === null ||
      metrics.coverage.functions < floor.functions
        ? [
            `${name}: functions ${metrics.coverage.functions ?? 'n/a'} < ${floor.functions}`,
          ]
        : []),
    ];
  });
}

const args = new Set(Bun.argv.slice(2));
const snapshot = await createSnapshot();
if (args.has('--check')) {
  const failures = checkPolicy(snapshot, await readPolicy());
  if (failures.length) {
    console.error(['Metrics policy failed:', ...failures].join('\n'));
    process.exit(1);
  }
}
if (args.has('--append'))
  await appendFile(
    join(root, 'docs/metrics/history.jsonl'),
    `${JSON.stringify(snapshot)}\n`,
  );
console.log(JSON.stringify(snapshot, null, 2));
