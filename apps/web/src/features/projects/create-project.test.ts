import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { projectInvariantIds } from '@offense-demo/domain';
import { PROJECT_CREATE_RULE } from './projects';
import {
  anonymous,
  answer,
  now,
  post,
  provisional,
  setup,
  unavailable,
} from './projects.test-support';

setupRitewayBun();

describe('POST /api/projects', () => {
  test('a member creates a project through the domain, owned by the principal', async () => {
    const { create, calls } = setup();
    const response = await create(post({ name: '  Alpha  ' }));
    assert({
      given: 'a member posting { name } with an injected clock and ids',
      should:
        'store the domain-created project (trimmed name, injected id and time) under the session principal and answer it with 201',
      actual: {
        status: response.status,
        body: await response.json(),
        inserted: calls.inserted,
        consumed: calls.consumed,
      },
      expected: {
        status: 201,
        body: {
          project: {
            id: 'p1',
            name: 'Alpha',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        },
        inserted: [
          {
            id: 'p1',
            ownerUserId: 'user1',
            name: 'Alpha',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
        consumed: [{ key: 'projects:create:user1', rule: PROJECT_CREATE_RULE }],
      },
    });
  });

  test('a provisional account is refused before anything is read or written', async () => {
    const { create, calls, logged } = setup({ identity: provisional });
    assert({
      given: 'a signed-in account with no username yet',
      should:
        'answer 403 AUTHORIZATION, log the denial and spend, load and write nothing',
      actual: {
        answer: await answer(await create(post({ name: 'Alpha' }))),
        loads: calls.loads,
        consumed: calls.consumed,
        inserted: calls.inserted,
        denied: logged.filter(({ event }) => event === 'authz.denied'),
      },
      expected: {
        answer: { status: 403, code: 'AUTHORIZATION', invariantId: undefined },
        loads: [],
        consumed: [],
        inserted: [],
        denied: [
          {
            event: 'authz.denied',
            fields: { denyReason: 'missing-capability' },
          },
        ],
      },
    });
  });

  test('an anonymous POST is refused as AUTHENTICATION before its body is read', async () => {
    const { create, calls } = setup({ identity: anonymous });
    const answers = await Promise.all(
      ['not json', '{"name":', JSON.stringify({ owner: 'x' })].map(
        async (body) => answer(await create(post(body))),
      ),
    );
    assert({
      given: 'anonymous POSTs whose bodies are invalid',
      should:
        'answer 401 AUTHENTICATION (not VALIDATION) and spend or write nothing',
      actual: {
        answers,
        consumed: calls.consumed,
        inserted: calls.inserted,
      },
      expected: {
        answers: Array(3).fill({
          status: 401,
          code: 'AUTHENTICATION',
          invariantId: undefined,
        }),
        consumed: [],
        inserted: [],
      },
    });
  });

  test('any field besides name, an owner id included, is refused as VALIDATION', async () => {
    const { create, calls } = setup();
    const answers = await Promise.all(
      [
        { name: 'Alpha', ownerUserId: 'user2' },
        { name: 'Alpha', owner_user_id: 'user2' },
        { name: 'Alpha', id: 'chosen-id' },
        { name: 'Alpha', status: 'archived' },
        {},
        { name: 42 },
        { name: null },
        ['Alpha'],
        'not json',
      ].map(async (body) => answer(await create(post(body)))),
    );
    assert({
      given: 'member bodies that are not exactly { name: string }',
      should: 'answer 400 VALIDATION and write nothing',
      actual: { answers, inserted: calls.inserted },
      expected: {
        answers: Array(9).fill({
          status: 400,
          code: 'VALIDATION',
          invariantId: undefined,
        }),
        inserted: [],
      },
    });
  });

  test('a blank name or one over 120 characters is refused with the domain invariant', async () => {
    const { create, calls } = setup();
    const answers = await Promise.all(
      ['', '   ', 'a'.repeat(121)].map(async (name) =>
        answer(await create(post({ name }))),
      ),
    );
    assert({
      given: 'a blank name and a 121-character name',
      should: `answer 422 INVARIANT ${projectInvariantIds.nameValid} and write nothing`,
      actual: { answers, inserted: calls.inserted },
      expected: {
        answers: Array(3).fill({
          status: 422,
          code: 'INVARIANT',
          invariantId: projectInvariantIds.nameValid,
        }),
        inserted: [],
      },
    });
  });

  test('a 120-character name is the longest accepted', async () => {
    const { create, calls } = setup();
    const name = 'a'.repeat(120);
    assert({
      given: 'a name of exactly 120 characters',
      should: 'create the project',
      actual: {
        status: (await create(post({ name }))).status,
        inserted: calls.inserted.length,
      },
      expected: { status: 201, inserted: 1 },
    });
  });

  test('a cross-site POST is refused by the same-origin check before the body is read', async () => {
    const { create, calls } = setup();
    const crossSite = post(
      { name: 'Alpha' },
      { origin: 'https://evil.example' },
    );
    const answers = [await answer(await create(crossSite))];
    const opaque = await answer(
      await create(
        post(
          { name: 'Alpha' },
          { origin: 'null', 'sec-fetch-site': 'same-origin' },
        ),
      ),
    );
    assert({
      given: 'a POST from another origin, and one with the opaque Origin: null',
      should:
        'answer 403 AUTHORIZATION without resolving a session, reading the body or writing',
      actual: {
        answers: [...answers, opaque],
        bodyRead: crossSite.bodyUsed,
        identify: calls.identify,
        inserted: calls.inserted,
      },
      expected: {
        answers: Array(2).fill({
          status: 403,
          code: 'AUTHORIZATION',
          invariantId: undefined,
        }),
        bodyRead: false,
        identify: 0,
        inserted: [],
      },
    });
  });

  test('ISSUE-3: a member over the per-user create ceiling is refused with RATE_LIMIT', async () => {
    const { create, calls } = setup({
      decide: async () => ({ allowed: false, retryAfterSeconds: 30 }),
    });
    assert({
      given: 'a member whose create allowance is spent',
      should: 'answer 429 RATE_LIMIT from their own bucket and write nothing',
      actual: {
        answer: await answer(await create(post({ name: 'Alpha' }))),
        consumed: calls.consumed,
        inserted: calls.inserted,
      },
      expected: {
        answer: { status: 429, code: 'RATE_LIMIT', invariantId: undefined },
        consumed: [{ key: 'projects:create:user1', rule: PROJECT_CREATE_RULE }],
        inserted: [],
      },
    });
  });

  test('a limiter outage fails closed with 503 and writes nothing', async () => {
    const { create, calls } = setup({
      decide: async () => {
        throw new Error('redis down');
      },
    });
    assert({
      given: 'a limiter that throws',
      should: 'answer 503 INFRASTRUCTURE and write nothing',
      actual: {
        answer: await answer(await create(post({ name: 'Alpha' }))),
        inserted: calls.inserted,
      },
      expected: {
        answer: {
          status: 503,
          code: 'INFRASTRUCTURE',
          invariantId: undefined,
        },
        inserted: [],
      },
    });
  });

  test('a session-store outage is a retryable 503, not a sign-out', async () => {
    const { create, calls } = setup({ identity: unavailable });
    assert({
      given: 'an identity that could not be resolved',
      should: 'answer 503 INFRASTRUCTURE and load or write nothing',
      actual: {
        answer: await answer(await create(post({ name: 'Alpha' }))),
        loads: calls.loads,
        inserted: calls.inserted,
      },
      expected: {
        answer: {
          status: 503,
          code: 'INFRASTRUCTURE',
          invariantId: undefined,
        },
        loads: [],
        inserted: [],
      },
    });
  });
});
