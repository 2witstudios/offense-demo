import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  archiveProject,
  createProject,
  projectInvariantIds,
  renameProject,
} from '@offense-demo/domain';

const root = resolve(import.meta.dir, '..');
const fixtureId = 'fixture-project';
const clock = { now: () => '2026-01-01T00:00:00.000Z' };

export type InvariantSpecEntry = {
  readonly id: string;
  readonly check: string;
  readonly testReference: {
    readonly path: string;
    readonly name: string;
  };
};

export type InvariantSpec = {
  readonly version: number;
  readonly invariants: readonly InvariantSpecEntry[];
};

export type InvariantResult = {
  readonly id: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
};

export type InvariantReport = {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly results: readonly InvariantResult[];
};

type Fixture = () => void;
type TestSources = Readonly<Record<string, string>>;

const createFixtureProject = (name = 'Fixture project') =>
  createProject({ name }, { clock, ids: { next: () => fixtureId } });

const fixtures: Readonly<Record<string, Fixture>> = {
  'name-valid': () => createFixtureProject('   '),
  'rename-changes-name': () =>
    renameProject(createFixtureProject(), 'Fixture project', { clock }),
  'archived-is-terminal': () =>
    archiveProject(archiveProject(createFixtureProject(), { clock }), {
      clock,
    }),
};

const registryIds: readonly string[] = Object.values(projectInvariantIds);

/** The invariant id an app error carries, if any. */
export function invariantId(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('invariantId' in error))
    return undefined;
  const value = (error as { invariantId?: unknown }).invariantId;
  return typeof value === 'string' ? value : undefined;
}

export function checkInvariantSpec(
  spec: InvariantSpec,
  registeredIds: readonly string[] = registryIds,
  sources: TestSources = {},
): readonly string[] {
  const specIds = spec.invariants.map(({ id }) => id);
  const issues = [
    ...(spec.version === 1
      ? []
      : [`spec: unsupported version ${spec.version}`]),
    ...specIds
      .filter((id, index) => specIds.indexOf(id) !== index)
      .map((id) => `spec: duplicate invariant entry ${id}`),
    ...registeredIds
      .filter((id) => !specIds.includes(id))
      .map((id) => `registry: missing spec entry for ${id}`),
    ...specIds
      .filter((id) => !registeredIds.includes(id))
      .map((id) => `registry: unknown spec entry ${id}`),
    ...spec.invariants
      .filter(({ check }) => fixtures[check] === undefined)
      .map(({ check }) => `check: ${check} has no registered fixture`),
    ...spec.invariants.flatMap(({ id, testReference }) => {
      const source = sources[testReference.path];
      return source === undefined
        ? [`test-reference: ${testReference.path} is unavailable`]
        : [
            ...(source.includes(testReference.name)
              ? []
              : [
                  `test-reference: ${testReference.name} is absent from ${testReference.path}`,
                ]),
            ...(source.includes(id)
              ? []
              : [`test-reference: ${id} is absent from ${testReference.path}`]),
          ];
    }),
  ];
  return [...new Set(issues)].sort();
}

function runFixture(entry: InvariantSpecEntry): InvariantResult {
  const fixture = fixtures[entry.check];
  if (fixture === undefined)
    return { id: entry.id, status: 'fail', detail: 'fixture unavailable' };
  try {
    fixture();
    return {
      id: entry.id,
      status: 'fail',
      detail: 'fixture completed without an invariant violation',
    };
  } catch (error) {
    const actual = invariantId(error);
    return actual === entry.id
      ? { id: entry.id, status: 'pass', detail: entry.check }
      : {
          id: entry.id,
          status: 'fail',
          detail: `expected ${entry.id}, got ${actual ?? 'no invariant ID'}`,
        };
  }
}

export function runInvariantChecks(
  spec: InvariantSpec,
  registered = registryIds,
): InvariantReport {
  const results = registered.map((id) => {
    const entry = spec.invariants.find((candidate) => candidate.id === id);
    return entry === undefined
      ? {
          id,
          status: 'fail' as const,
          detail: 'missing spec entry',
        }
      : runFixture(entry);
  });
  return {
    ok: results.every(({ status }) => status === 'pass'),
    issues: [],
    results,
  };
}

export function formatInvariantReport(
  report: InvariantReport,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Offense Demo invariants: ${report.ok ? 'PASS' : 'FAIL'}`,
    ...report.issues.map((issue) => `FAIL ${issue}`),
    ...report.results.map(
      ({ id, status, detail }) =>
        `${status === 'pass' ? 'PASS' : 'FAIL'} ${id}: ${detail}`,
    ),
    '',
  ].join('\n');
}

async function readSpec(): Promise<InvariantSpec> {
  return JSON.parse(
    await readFile(resolve(root, 'spec/invariants.json'), 'utf8'),
  ) as InvariantSpec;
}

async function readTestSources(spec: InvariantSpec): Promise<TestSources> {
  const paths = [
    ...new Set(spec.invariants.map(({ testReference }) => testReference.path)),
  ];
  const entries = await Promise.all(
    paths.map(
      async (path) =>
        [path, await readFile(resolve(root, path), 'utf8')] as const,
    ),
  );
  return Object.fromEntries(entries);
}

if (import.meta.main) {
  try {
    const spec = await readSpec();
    const sources = await readTestSources(spec);
    const issues = checkInvariantSpec(spec, registryIds, sources);
    const checks = runInvariantChecks(spec);
    const report = {
      ...checks,
      ok: issues.length === 0 && checks.ok,
      issues,
    };
    process.stdout.write(
      formatInvariantReport(report, Bun.argv.includes('--json')),
    );
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const report: InvariantReport = {
      ok: false,
      issues: [error instanceof Error ? error.message : 'unable to load spec'],
      results: [],
    };
    process.stdout.write(
      formatInvariantReport(report, Bun.argv.includes('--json')),
    );
    process.exitCode = 1;
  }
}
