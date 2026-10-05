import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { PROJECT_CREATE_RULE } from './projects';
import { answer, post, setup } from './projects.test-support';

setupRitewayBun();

/**
 * PROJ-2.4: the POST gates' strictness and order. Each test fails under a
 * named negative control: the no-Origin test when POST uses the permissive
 * `requireSameOriginRead`, the ceiling tests when `consumeOrThrow` moves
 * after `parseValidated`.
 */
describe('POST /api/projects gate strictness and order', () => {
  test('a member POST with no Origin and no Sec-Fetch-Site is refused (the gate fails closed)', async () => {
    const { create, calls } = setup();
    const signed = post({ name: 'Alpha' });
    const headers = new Headers(signed.headers);
    headers.delete('origin');
    const unsigned = new Request(signed, { headers });
    const sent = {
      origin: unsigned.headers.get('origin'),
      fetchSite: unsigned.headers.get('sec-fetch-site'),
    };
    assert({
      given:
        'a member’s valid POST carrying neither an Origin nor a Sec-Fetch-Site header',
      should:
        'answer 403 AUTHORIZATION without resolving a session, spending the ceiling, reading the body or writing',
      actual: {
        sent,
        answer: await answer(await create(unsigned)),
        bodyRead: unsigned.bodyUsed,
        identify: calls.identify,
        consumed: calls.consumed,
        inserted: calls.inserted,
      },
      expected: {
        sent: { origin: null, fetchSite: null },
        answer: { status: 403, code: 'AUTHORIZATION', invariantId: undefined },
        bodyRead: false,
        identify: 0,
        consumed: [],
        inserted: [],
      },
    });
  });

  test('a member’s invalid body still spends the create ceiling (ceiling, then body)', async () => {
    const { create, calls } = setup();
    const answers = await Promise.all(
      ['not json', JSON.stringify({ name: 'Alpha', extra: true })].map(
        async (body) => answer(await create(post(body))),
      ),
    );
    assert({
      given: 'a member posting a malformed body and one with an extra field',
      should:
        'spend the member’s create ceiling once per request before refusing the body as VALIDATION, and write nothing',
      actual: {
        answers,
        consumed: calls.consumed,
        inserted: calls.inserted,
      },
      expected: {
        answers: Array(2).fill({
          status: 400,
          code: 'VALIDATION',
          invariantId: undefined,
        }),
        consumed: Array(2).fill({
          key: 'projects:create:user1',
          rule: PROJECT_CREATE_RULE,
        }),
        inserted: [],
      },
    });
  });

  test('a member whose ceiling is spent is refused RATE_LIMIT before an invalid body is read', async () => {
    const { create, calls } = setup({
      decide: async () => ({ allowed: false, retryAfterSeconds: 30 }),
    });
    const invalid = post('not json');
    assert({
      given: 'a member over the create ceiling posting an invalid body',
      should:
        'answer 429 RATE_LIMIT (not VALIDATION) without reading the body, and write nothing',
      actual: {
        answer: await answer(await create(invalid)),
        bodyRead: invalid.bodyUsed,
        consumed: calls.consumed,
        inserted: calls.inserted,
      },
      expected: {
        answer: { status: 429, code: 'RATE_LIMIT', invariantId: undefined },
        bodyRead: false,
        consumed: [{ key: 'projects:create:user1', rule: PROJECT_CREATE_RULE }],
        inserted: [],
      },
    });
  });
});
