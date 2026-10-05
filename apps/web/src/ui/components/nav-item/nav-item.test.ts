import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { matchesRoute } from './nav-item';

setupRitewayBun();

describe('matchesRoute', () => {
  test('is exact-only for the home route', () => {
    assert({
      given: 'the home href "/"',
      should: 'match only the root path, never a descendant',
      actual: [matchesRoute('/', '/'), matchesRoute('/app', '/')],
      expected: [true, false],
    });
  });

  test('matches a descendant of a non-root route', () => {
    assert({
      given: 'a settings href with a nested security route open',
      should: 'stay active on the descendant',
      actual: [
        matchesRoute('/settings', '/settings'),
        matchesRoute('/settings/security', '/settings'),
        matchesRoute('/settingsx', '/settings'),
      ],
      expected: [true, true, false],
    });
  });
});
