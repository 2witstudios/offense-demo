import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { guardedAreaFor, requirementFor, type GuardedAreas } from './decision';

setupRitewayBun();

/**
 * A table shaped like a grown product's: a public `/projects` root holding
 * guarded areas beside a single-segment guarded root. The shipped table
 * (`appConfig.guardedAreas`) is exercised in decision.test.ts.
 */
const areas: GuardedAreas = {
  '/app': 'participant',
  '/projects/manage': 'participant',
  '/projects/mine': 'participant',
  '/settings': 'account',
};
const requirementsOf = (paths: readonly string[]) =>
  paths.map((path) => requirementFor(path, areas));

describe('guarded areas under a public root', () => {
  test('a public root can hold guarded children, matched longest first', () => {
    assert({
      given:
        'the public /projects root, its guarded areas, descendants and lookalikes',
      should:
        'guard only the named areas and their descendants, on a segment boundary',
      actual: requirementsOf([
        '/projects',
        '/projects/',
        '/projects/autumn',
        '/projects/autumn/board',
        '/projects/manage',
        '/projects/manage/',
        '/projects/manage/x',
        '/projects/manage/x/y',
        '/projects/mine',
        '/projects/mine/x/room/1',
        '/projects/mineral',
        '/projects/mineral/x',
        '/projects/manager',
        '/projects/Manage',
        '/Projects/manage',
      ]),
      expected: [
        null,
        null,
        null,
        null,
        'participant',
        'participant',
        'participant',
        'participant',
        'participant',
        'participant',
        null,
        null,
        null,
        null,
        null,
      ],
    });
  });

  test('malformed paths never unguard an area', () => {
    assert({
      given: 'double slashes inside a guarded path and before a single segment',
      should:
        'collapse interior empties, and leave a leading double slash as today',
      actual: requirementsOf([
        '/projects//manage',
        '/projects/manage//x',
        '/app//x',
        '//app',
        '',
      ]),
      expected: ['participant', 'participant', 'participant', null, null],
    });
  });

  test('guardedAreaFor names the matched area', () => {
    assert({
      given: 'a nested guarded path, a single-segment one and a public one',
      should: 'answer the longest matching area, or null',
      actual: ['/projects/manage/x', '/app/abc', '/projects/autumn'].map(
        (path) => guardedAreaFor(path, areas),
      ),
      expected: ['/projects/manage', '/app', null],
    });
  });

  test('an inherited object key is never an area', () => {
    assert({
      given: 'paths naming Object.prototype members',
      should: 'stay public',
      actual: requirementsOf(['/constructor', '/__proto__', '/toString']),
      expected: [null, null, null],
    });
  });
});
