import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  anonymous,
  answer,
  get,
  now,
  provisional,
  setup,
  stored,
} from './projects.test-support';

setupRitewayBun();

describe('GET /api/projects', () => {
  test("a member gets their own projects, in the store's newest-first order", async () => {
    const newer = stored({
      id: 'p2',
      name: 'Beta',
      createdAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T10:00:00.000Z',
    });
    const older = stored();
    const { list, calls } = setup({ listed: [newer, older] });
    const response = await list(get());
    assert({
      given: 'a member whose store answers two projects newest first',
      should:
        'ask the store for the principal’s projects only and answer them in that order, without owner or row version',
      actual: {
        status: response.status,
        body: await response.json(),
        listed: calls.listed,
        loads: calls.loads,
      },
      expected: {
        status: 200,
        body: {
          projects: [
            {
              id: 'p2',
              name: 'Beta',
              status: 'active',
              createdAt: '2026-10-05T10:00:00.000Z',
              updatedAt: '2026-10-05T10:00:00.000Z',
            },
            {
              id: 'p1',
              name: 'Alpha',
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        listed: ['user1'],
        loads: [{ userId: 'user1', resourceRef: { kind: 'projects' } }],
      },
    });
  });

  test('an anonymous or provisional GET answers NOT_FOUND and lists nothing', async () => {
    const anon = setup({ identity: anonymous });
    const pending = setup({ identity: provisional });
    assert({
      given: 'no session, and an account with no username',
      should: 'answer 404 NOT_FOUND to both and never read the store',
      actual: {
        answers: [
          await answer(await anon.list(get())),
          await answer(await pending.list(get())),
        ],
        listed: [...anon.calls.listed, ...pending.calls.listed],
      },
      expected: {
        answers: Array(2).fill({
          status: 404,
          code: 'NOT_FOUND',
          invariantId: undefined,
        }),
        listed: [],
      },
    });
  });

  test('a cross-site read is refused before the session is resolved', async () => {
    const { list, calls } = setup();
    assert({
      given: 'a GET carrying cross-site fetch metadata',
      should: 'answer 403 AUTHORIZATION and resolve or list nothing',
      actual: {
        answer: await answer(
          await list(get({ 'sec-fetch-site': 'cross-site' })),
        ),
        identify: calls.identify,
        listed: calls.listed,
      },
      expected: {
        answer: { status: 403, code: 'AUTHORIZATION', invariantId: undefined },
        identify: 0,
        listed: [],
      },
    });
  });
});
