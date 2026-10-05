import { stylingRuleApplies, stylingRules } from './policy-styling';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

import { auditPolicyProblems } from './audit';
import { numberCollisionProblems } from './number-claims';
import { collectWorkflowHardeningProblems } from './workflow-hardening';
import {
  duplicateAdrNumberProblems,
  type MigrationBaseline,
  type PolicyException,
  type PolicyRule,
  validateMigrationBaselines,
  validatePolicyRegistry,
} from './policy-registry';

const root = resolve(import.meta.dir, '..');
const registryPath = join(root, 'policy/exceptions.json');
const skipped = new Set([
  '.git',
  '.next',
  '.pu',
  '.turbo',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const scannedExtensions = new Set([
  '.js',
  '.jsx',
  '.json',
  '.sql',
  '.ts',
  '.tsx',
]);
export type PolicyFinding = {
  readonly path: string;
  readonly line: number;
  readonly rule: PolicyRule;
  readonly detail: string;
};
export type PolicyReport = {
  readonly ok: boolean;
  readonly findings: readonly PolicyFinding[];
  readonly registryProblems: readonly string[];
};

const rules: Readonly<Record<PolicyRule, RegExp>> = {
  'direct-random-uuid': /\b(?:crypto\.)?randomUUID\s*\(/,
  'repository-owned-uuid':
    /\b(?:z\.uuid\s*\(|uuid\s*\(|uuidv[134]\s*\(|from\s+['"]uuid['"]|::uuid\b)/i,
  ...stylingRules,
};

function aliasedRandomUuidFindings(
  path: string,
  content: string,
): readonly PolicyFinding[] {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : path.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.TS,
  );
  const aliases = new Set<string>();
  const findings: PolicyFinding[] = [];

  function collectAliases(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'node:crypto' ||
        node.moduleSpecifier.text === 'crypto') &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if (
          element.propertyName?.text === 'randomUUID' &&
          ts.isIdentifier(element.name)
        )
          aliases.add(element.name.text);
      }
    }
    ts.forEachChild(node, collectAliases);
  }

  const findingLines = new Set<number>();
  function collectCalls(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      aliases.has(node.expression.text) &&
      !findingLines.has(
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      )
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      findingLines.add(line);
      findings.push({
        path,
        line,
        rule: 'direct-random-uuid',
        detail: content.split('\n')[line - 1]?.trim() ?? '',
      });
    }

    ts.forEachChild(node, collectCalls);
  }

  collectAliases(sourceFile);
  collectCalls(sourceFile);
  return findings;
}

export function scanPolicyText(
  path: string,
  content: string,
): readonly PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const [lineIndex, line] of content.split('\n').entries()) {
    for (const [rule, pattern] of Object.entries(rules) as [
      PolicyRule,
      RegExp,
    ][]) {
      if (stylingRuleApplies(rule, path) && pattern.test(line))
        findings.push({
          path,
          line: lineIndex + 1,
          rule,
          detail: line.trim(),
        });
    }
  }
  const existingLines = new Set(
    findings
      .filter(({ rule }) => rule === 'direct-random-uuid')
      .map(({ line }) => line),
  );
  return [
    ...findings,
    ...aliasedRandomUuidFindings(path, content).filter(
      ({ line }) => !existingLines.has(line),
    ),
  ];
}

async function filesIn(
  directory: string,
  extensions: ReadonlySet<string> | undefined,
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name))
        files.push(...(await filesIn(join(directory, entry.name), extensions)));
    } else if (
      entry.isFile() &&
      (extensions === undefined ||
        extensions.has(entry.name.slice(entry.name.lastIndexOf('.'))))
    )
      files.push(join(directory, entry.name));
  }
  return files;
}

export async function collectPolicy(): Promise<PolicyReport> {
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    version?: unknown;
    exceptions?: readonly PolicyException[];
  };
  const baselinesFile = Bun.file(join(root, 'policy/migration-baselines.json'));
  const baselinesRegistry = (await baselinesFile.exists())
    ? ((await baselinesFile.json()) as {
        version?: unknown;
        baselines?: readonly MigrationBaseline[];
      })
    : { version: 1, baselines: [] };
  const repositoryFiles = await filesIn(root, scannedExtensions);
  const knownPaths = new Set(
    (await filesIn(root, undefined)).map((file) => relative(root, file)),
  );
  const problems = [
    ...validatePolicyRegistry(registry, { knownPaths }),
    ...(await auditPolicyProblems(knownPaths)),
    ...validateMigrationBaselines(baselinesRegistry, { knownPaths }),
    ...duplicateAdrNumberProblems(knownPaths),
    ...numberCollisionProblems(),
    ...collectWorkflowHardeningProblems(root),
  ];
  const exceptions = new Set(
    (registry.exceptions ?? []).map(({ path, rule }) => `${path}|${rule}`),
  );
  const findings: PolicyFinding[] = [];
  for (const file of repositoryFiles) {
    const path = relative(root, file);
    if (/^scripts\/policy(-styling|\.test)?\.ts$/.test(path)) continue;
    for (const finding of scanPolicyText(path, await readFile(file, 'utf8')))
      if (!exceptions.has(`${finding.path}|${finding.rule}`))
        findings.push(finding);
  }
  return {
    ok: problems.length === 0 && findings.length === 0,
    findings,
    registryProblems: problems,
  };
}

export function formatPolicyReport(
  report: PolicyReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Offense Demo policy: ${report.ok ? 'PASS' : 'FAIL'}`,
    ...report.registryProblems.map((problem) => `  REGISTRY: ${problem}`),
    ...report.findings.map(
      ({ path, line, rule, detail }) =>
        `  ${rule}: ${path}:${line} (${detail})`,
    ),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const report = await collectPolicy();
  process.stdout.write(
    formatPolicyReport(report, process.argv.includes('--json')),
  );
  process.exitCode = report.ok ? 0 : 1;
}
