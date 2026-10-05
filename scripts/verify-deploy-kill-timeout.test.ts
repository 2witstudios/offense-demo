import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readFileSync } from 'node:fs';
import { findKillTimeoutProblem } from './verify-deploy-config';

setupRitewayBun();

describe('findKillTimeoutProblem (ISSUE-214)', () => {
  const budget = 'export const SHUTDOWN_DRAIN_DEADLINE_MS = 25_000;\n';
  const start =
    'await drainWithDeadline({\n    deadlineMs: SHUTDOWN_DRAIN_DEADLINE_MS,\n';
  const problem = (
    flyToml: string,
    shutdownBudgetTs = budget,
    startTs = start,
  ) => findKillTimeoutProblem({ flyToml, shutdownBudgetTs, startTs });

  test('the committed fly.toml outlasts the committed drain deadline', () => {
    assert({
      given: 'the real fly.toml, shutdown budget and start.ts',
      should: 'report no problem',
      actual: findKillTimeoutProblem({
        flyToml: readFileSync('fly.toml', 'utf8'),
        shutdownBudgetTs: readFileSync(
          'apps/web/src/server/shutdown-budget.ts',
          'utf8',
        ),
        startTs: readFileSync('apps/web/src/server/start.ts', 'utf8'),
      }),
      expected: null,
    });
  });

  test('a kill_timeout at least the drain deadline plus the margin, in seconds or as a duration', () => {
    assert({
      given: 'kill_timeout = 35 and kill_timeout = "40s" at the top level',
      should: 'report no problem',
      actual: [
        problem('app = "a"\nkill_timeout = 35\n[env]\n'),
        problem('app = "a"\nkill_timeout = "40s"\n'),
      ],
      expected: [null, null],
    });
  });

  test('a kill_timeout Fly would cut the drain off with', () => {
    const tooShort =
      'fly.toml kill_timeout must be at least 35 s (the 25 s shutdown drain plus 10 s margin); Fly SIGKILLs a machine that has not exited by then (ISSUE-214)';
    assert({
      given:
        'no kill_timeout (Fly defaults to 5 s), 30 s, a commented-out one, and one inside a table instead of the top level',
      should: 'report each as too short',
      actual: [
        problem('app = "a"\n'),
        problem('app = "a"\nkill_timeout = 30\n'),
        problem('app = "a"\n# kill_timeout = 60\n'),
        problem('app = "a"\n[env]\n  kill_timeout = 60\n'),
      ],
      expected: [tooShort, tooShort, tooShort, tooShort],
    });
  });

  test('a drain deadline the check cannot read, or that start.ts does not use', () => {
    assert({
      given:
        'a shutdown budget without its constant, and a start.ts draining with a literal deadline',
      should: 'report each',
      actual: [
        problem('kill_timeout = 60\n', 'export const OTHER = 1;\n'),
        problem('kill_timeout = 60\n', budget, 'deadlineMs: 25_000,\n'),
      ],
      expected: [
        'shutdown-budget.ts does not export SHUTDOWN_DRAIN_DEADLINE_MS as a number of milliseconds',
        'start.ts does not drain with deadlineMs: SHUTDOWN_DRAIN_DEADLINE_MS',
      ],
    });
  });
});
