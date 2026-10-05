import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { countsByProject, countsProblems } from './e2e-report-counts';

setupRitewayBun();

const test_ = (
  projectName: string,
  results: { status: string; retry: number }[],
) => ({ projectName, results });

describe('e2e counts report', () => {
  test('tallies discovered/executed/pass/fail/skip per project', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: 'passes',
              tests: [test_('functional', [{ status: 'passed', retry: 0 }])],
            },
            {
              title: 'fails',
              tests: [test_('functional', [{ status: 'failed', retry: 0 }])],
            },
            {
              title: 'is skipped',
              file: 'e2e/journey.e2e.ts',
              line: 7,
              tests: [test_('functional', [{ status: 'skipped', retry: 0 }])],
            },
          ],
        },
      ],
    };
    assert({
      given: 'a report with one pass, one fail and one skip in one project',
      should: 'tally each bucket correctly and name the skipped test',
      actual: countsByProject(report),
      expected: {
        functional: {
          discovered: 3,
          executed: 2,
          passed: 1,
          failed: 1,
          skipped: 1,
          retried: 0,
          skippedTests: ['e2e/journey.e2e.ts:7 "is skipped"'],
        },
      },
    });
  });

  test('walks nested suites', () => {
    const report = {
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  tests: [
                    test_('functional', [{ status: 'passed', retry: 0 }]),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    assert({
      given: 'a spec nested two suites deep',
      should: 'still be counted',
      actual: countsByProject(report).functional?.discovered,
      expected: 1,
    });
  });

  test('flags a test that needed a retry to pass', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              tests: [
                test_('functional', [
                  { status: 'failed', retry: 0 },
                  { status: 'passed', retry: 1 },
                ]),
              ],
            },
          ],
        },
      ],
    };
    assert({
      given: 'a test whose only passing result came from a retry',
      should: 'report RETRY_PASS',
      actual: countsProblems(countsByProject(report)).map((p) => p.code),
      expected: ['RETRY_PASS'],
    });
  });

  test('flags an empty selection', () => {
    assert({
      given: 'a report with no suites at all',
      should: 'report EMPTY_SELECTION',
      actual: countsProblems(countsByProject({ suites: [] })).map(
        (p) => p.code,
      ),
      expected: ['EMPTY_SELECTION'],
    });
  });

  test('flags a skipped test by name (ISSUE-164)', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: 'a required journey',
              file: 'e2e/journey.e2e.ts',
              line: 12,
              tests: [test_('functional', [{ status: 'skipped', retry: 0 }])],
            },
          ],
        },
      ],
    };
    const problems = countsProblems(countsByProject(report));
    assert({
      given: 'a required project reporting one skipped test',
      should: 'report SKIPPED_TEST naming that test by file, line and title',
      actual: problems,
      expected: [
        {
          code: 'SKIPPED_TEST',
          detail:
            'functional: e2e/journey.e2e.ts:12 "a required journey" was skipped; a required E2E project may not skip, fixme or focus a test',
        },
      ],
    });
  });

  test('reports nothing for a clean, non-empty, non-retried run', () => {
    const byProject = countsByProject({
      suites: [
        {
          specs: [
            { tests: [test_('functional', [{ status: 'passed', retry: 0 }])] },
          ],
        },
      ],
    });
    assert({
      given: 'a normal green run',
      should: 'report no problems',
      actual: countsProblems(byProject),
      expected: [],
    });
  });
});
