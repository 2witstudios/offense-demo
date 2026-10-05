import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { rejectionOf } from '@offense-demo/errors/testing';
import { requireSameOriginForm } from './http';

setupRitewayBun();

const outcome = (headers: Record<string, string>) =>
  rejectionOf(() =>
    requireSameOriginForm(
      new Request('http://localhost/auth/confirm', { headers }),
      'http://localhost:3000',
    ),
  );
const admitted = { code: 'NO_REJECTION' };
const refused = { code: 'AUTHORIZATION' };

describe('requireSameOriginForm: opaque form origins', () => {
  test('accepts the origin a no-referrer page sends only from the same origin', async () => {
    assert({
      given:
        'Origin null with Sec-Fetch-Site same-origin, and the plain origin',
      should: 'admit both',
      actual: [
        await outcome({ origin: 'null', 'sec-fetch-site': 'same-origin' }),
        await outcome({ origin: 'http://localhost:3000' }),
      ],
      expected: [admitted, admitted],
    });
  });

  test('refuses an opaque origin that is not provably same-origin', async () => {
    const cases = [
      { origin: 'null' },
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
      { origin: 'null', 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
      {},
    ];
    assert({
      given:
        'an opaque, cross-site, same-site, foreign or missing origin on a form post',
      should: 'refuse every one with AUTHORIZATION',
      actual: await Promise.all(cases.map(outcome)),
      expected: cases.map(() => refused),
    });
  });
});
