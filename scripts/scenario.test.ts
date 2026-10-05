import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import lifecycle from '../scenarios/project-lifecycle';
import {
  runScenario,
  ScenarioExpectationError,
  type ProjectScenario,
} from './scenario';

setupRitewayBun();

const scenario: ProjectScenario = {
  name: 'lifecycle',
  given: {
    clock: '2026-01-01T00:00:00.000Z',
    ids: ['project-1'],
    projectName: 'Roadmap',
  },
  when: [{ type: 'rename', name: 'Plan' }, { type: 'archive' }],
  expect: {
    id: 'project-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    name: 'Plan',
    status: 'archived',
  },
};

describe('typed domain scenarios', () => {
  test('drives the domain with deterministic clock and identities', () => {
    const result = runScenario(scenario);
    assert({
      given: 'a typed lifecycle scenario with fixed time and identities',
      should: 'produce the expected project snapshot',
      actual: {
        id: result.id,
        createdAt: result.createdAt,
        name: result.name,
        status: result.status,
      },
      expected: scenario.expect,
    });
  });

  test('rejects an expectation that does not match the domain result', () => {
    let error: unknown;
    try {
      runScenario({
        ...scenario,
        expect: { ...scenario.expect, status: 'active' },
      });
    } catch (caught) {
      error = caught;
    }
    assert({
      given: 'a lifecycle scenario whose status expectation is violated',
      should:
        'report the failing expectation step with expected and actual values',
      actual: error instanceof ScenarioExpectationError ? error.report : error,
      expected: {
        type: 'scenario-expectation-failed',
        scenario: 'lifecycle',
        step: 'status',
        expected: 'active',
        actual: 'archived',
      },
    });
  });

  test('verifies rejected operations preserve state and identify the invariant', () => {
    const result = runScenario({
      ...scenario,
      name: 'rejection-atomicity',
      when: [
        {
          type: 'expect-rejection',
          operation: { type: 'rename', name: 'Roadmap' },
          invariantId: 'project.rename.changes-name',
        },
      ],
      expect: { ...scenario.expect, name: 'Roadmap', status: 'active' },
    });
    assert({
      given: 'a scenario containing a rejected no-op rename',
      should: 'finish with the unchanged active snapshot',
      actual: { name: result.name, status: result.status },
      expected: { name: 'Roadmap', status: 'active' },
    });
  });

  test('a rejection step fails when the operation succeeds', () => {
    let message: unknown;
    try {
      runScenario({
        ...scenario,
        when: [
          {
            type: 'expect-rejection',
            operation: { type: 'archive' },
            invariantId: 'project.archived.terminal',
          },
        ],
      });
    } catch (caught) {
      message = caught instanceof Error ? caught.message : caught;
    }
    assert({
      given: 'an expected rejection whose operation succeeds',
      should: 'fail the scenario naming the expected invariant',
      actual: message,
      expected:
        'Scenario "lifecycle" expected atomic rejection with invariant "project.archived.terminal"',
    });
  });

  test('the shipped example scenario passes', () => {
    assert({
      given: 'scenarios/project-lifecycle.ts',
      should: 'end archived with its renamed name',
      actual: runScenario(lifecycle).name,
      expected: 'Launch plan',
    });
  });
});
