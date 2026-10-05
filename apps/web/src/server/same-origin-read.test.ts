import { rejectionOf } from '@offense-demo/errors/testing';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireSameOriginRead } from './http';

setupRitewayBun();

const appOrigin = 'http://localhost:3000';
const outcome = (headers: Record<string, string>) =>
  rejectionOf(() =>
    requireSameOriginRead(
      new Request(`${appOrigin}/api/account/username?id=x`, { headers }),
      appOrigin,
    ),
  );
const allowed = { code: 'NO_REJECTION' };
const refused = { code: 'AUTHORIZATION' };

describe('requireSameOriginRead', () => {
  test('allows reads a browser or tool sends from the same origin', async () => {
    assert({
      given:
        'a GET carrying neither Origin nor Sec-Fetch-Site, as browsers send same-origin',
      should:
        'be allowed, deliberately: only positive cross-site evidence is refused',
      actual: await outcome({}),
      expected: allowed,
    });
    assert({
      given: 'fetch metadata declaring a same-origin request',
      should: 'be allowed',
      actual: await outcome({ 'sec-fetch-site': 'same-origin' }),
      expected: allowed,
    });
    assert({
      given: 'a user-initiated navigation (Sec-Fetch-Site: none)',
      should: 'be allowed',
      actual: await outcome({ 'sec-fetch-site': 'none' }),
      expected: allowed,
    });
    assert({
      given: 'an Origin header matching the application origin',
      should: 'be allowed',
      actual: await outcome({ origin: appOrigin }),
      expected: allowed,
    });
  });

  test('refuses reads initiated from another site', async () => {
    const cases = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'cross-site', origin: appOrigin },
    ];
    assert({
      given: 'a foreign or opaque origin, or cross-site fetch metadata',
      should: 'refuse every one with AUTHORIZATION',
      actual: await Promise.all(cases.map(outcome)),
      expected: cases.map(() => refused),
    });
  });
});
