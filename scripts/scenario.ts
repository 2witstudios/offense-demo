import { fixedClock, fixedIds } from '@offense-demo/clock';
import {
  archiveProject,
  createProject,
  renameProject,
  type Project,
  type ProjectStatus,
} from '@offense-demo/domain';
import { invariantId } from './invariants';

/**
 * Typed, deterministic domain scenarios (`bun scenario <name>` runs
 * `scenarios/<name>.ts`). Each scenario fixes the clock and identities,
 * applies operations to the example aggregate, and asserts the final
 * snapshot; an `expect-rejection` step also proves the refused operation
 * left the snapshot unchanged.
 */
export type ScenarioAction =
  | { readonly type: 'rename'; readonly name: string }
  | { readonly type: 'archive' }
  | {
      readonly type: 'expect-rejection';
      readonly operation: Exclude<
        ScenarioAction,
        { readonly type: 'expect-rejection' }
      >;
      readonly invariantId: string;
    };

export type ProjectScenario = {
  readonly name: string;
  readonly given: {
    readonly clock: string;
    readonly ids: readonly [string, ...string[]];
    readonly projectName: string;
  };
  readonly when: readonly ScenarioAction[];
  readonly expect: {
    readonly id: string;
    readonly createdAt: string;
    readonly name: string;
    readonly status: ProjectStatus;
  };
};

export type ScenarioExpectationReport = {
  readonly type: 'scenario-expectation-failed';
  readonly scenario: string;
  readonly step: keyof ProjectScenario['expect'];
  readonly expected: unknown;
  readonly actual: unknown;
};

export class ScenarioExpectationError extends Error {
  readonly report: ScenarioExpectationReport;

  constructor(report: ScenarioExpectationReport) {
    super(
      `Scenario "${report.scenario}" failed at step "${String(report.step)}": expected ${JSON.stringify(report.expected)} but received ${JSON.stringify(report.actual)}`,
    );
    this.name = 'ScenarioExpectationError';
    this.report = report;
  }
}

export function runScenario(scenario: ProjectScenario): Project {
  const { given } = scenario;
  const clock = fixedClock(given.clock);
  let project = createProject(
    { name: given.projectName },
    { clock, ids: fixedIds(given.ids) },
  );
  scenario.when.forEach((action) => {
    if (action.type === 'expect-rejection') {
      const before = JSON.stringify(project);
      let error: unknown;
      try {
        applyAction(project, action.operation, clock);
      } catch (caught) {
        error = caught;
      }
      if (
        error === undefined ||
        invariantId(error) !== action.invariantId ||
        JSON.stringify(project) !== before
      )
        throw new Error(
          `Scenario "${scenario.name}" expected atomic rejection with invariant "${action.invariantId}"`,
        );
    } else project = applyAction(project, action, clock);
  });
  assertScenario(scenario, project);
  return project;
}

function applyAction(
  project: Project,
  action: Exclude<ScenarioAction, { readonly type: 'expect-rejection' }>,
  clock: { now(): string },
): Project {
  return action.type === 'rename'
    ? renameProject(project, action.name, { clock })
    : archiveProject(project, { clock });
}

function assertScenario(scenario: ProjectScenario, project: Project): void {
  const expected = scenario.expect;
  const actual = {
    id: project.id,
    createdAt: project.createdAt,
    name: project.name,
    status: project.status,
  };
  const step = (['id', 'createdAt', 'name', 'status'] as const).find(
    (candidate) =>
      JSON.stringify(expected[candidate]) !== JSON.stringify(actual[candidate]),
  );
  if (step !== undefined)
    throw new ScenarioExpectationError({
      type: 'scenario-expectation-failed',
      scenario: scenario.name,
      step,
      expected: expected[step],
      actual: actual[step],
    });
}

async function loadScenario(name: string): Promise<ProjectScenario> {
  if (!/^[a-z0-9-]+$/.test(name))
    throw new Error(
      'Scenario names may contain only lowercase letters, numbers, and hyphens',
    );
  const module = await import(`../scenarios/${name}.ts`);
  return module.default as ProjectScenario;
}

if (import.meta.main) {
  const name = Bun.argv[2];
  if (!name) throw new Error('Usage: bun scenario <name>');
  try {
    runScenario(await loadScenario(name));
    console.log(`Scenario passed: ${name}`);
  } catch (error) {
    console.error(
      error instanceof ScenarioExpectationError
        ? JSON.stringify(error.report)
        : error instanceof Error
          ? error.message
          : error,
    );
    process.exitCode = 1;
  }
}
