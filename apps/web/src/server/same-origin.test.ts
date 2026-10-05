import { describe, setupRitewayBun, test } from 'riteway/bun';
import { assertRejects } from '@offense-demo/errors/testing';
import { requireSameOrigin } from './http';

setupRitewayBun();

describe('requireSameOrigin: strict gate for state-changing requests', () => {
  test('rejects cross-origin state-changing requests', async () => {
    await assertRejects({
      given: 'a state-changing request from another origin',
      should: 'refuse with AUTHORIZATION',
      actual: () =>
        requireSameOrigin(
          new Request('http://localhost/api/account/username', {
            headers: { origin: 'https://evil.example' },
          }),
          'http://localhost:3000',
        ),
      code: 'AUTHORIZATION',
    });
  });

  test('refuses the opaque form origin outside the no-referrer form gate', async () => {
    await assertRejects({
      given:
        'Origin null with Sec-Fetch-Site same-origin on the strict gate, not the form-specific one',
      should:
        'refuse with AUTHORIZATION: only requireSameOriginForm carves out Origin null',
      actual: () =>
        requireSameOrigin(
          new Request('http://localhost/api/account/username', {
            headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
          }),
          'http://localhost:3000',
        ),
      code: 'AUTHORIZATION',
    });
  });
});
