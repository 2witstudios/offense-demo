import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { sessionRefreshDue } from './session-policy';

setupRitewayBun();

describe('sessionRefreshDue', () => {
  const now = '2026-09-20T12:00:00.000Z';
  const expiresIn = (days: number) =>
    new Date(Date.parse(now) + days * 24 * 60 * 60 * 1000).toISOString();

  test('is due only once a day has passed since the last extension', () => {
    assert({
      given:
        'sessions extended just now, 23 hours ago, a day ago and 3 days ago',
      should: 'refresh only the ones extended a day or more ago',
      actual: [
        sessionRefreshDue(expiresIn(7), now),
        sessionRefreshDue(expiresIn(7 - 23 / 24), now),
        sessionRefreshDue(expiresIn(6), now),
        sessionRefreshDue(expiresIn(4), now),
      ],
      expected: [false, false, true, true],
    });
  });
});
