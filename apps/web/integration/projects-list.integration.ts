import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createProjectFlows, read } from './projects-flows';

requireTestServices(process.env);
setupRitewayBun();
const { memberAccount, provisionalAccount, create, list } =
  createProjectFlows();

describe('PROJ-2.1 GET /api/projects', () => {
  test('two members each get only their own projects, newest first', async () => {
    const ada = await memberAccount();
    const bob = await memberAccount();
    const created: Record<string, Array<{ id: string; createdAt: string }>> = {
      ada: [],
      bob: [],
    };
    // Sequential, interleaved creates: each member's later project is newer.
    for (const index of [1, 2, 3])
      for (const [who, account] of [
        ['ada', ada],
        ['bob', bob],
      ] as const) {
        const { body } = await read(
          await create(account.cookie, { name: `${who} ${index}` }),
        );
        created[who]!.push(body.project!);
      }
    const newestFirst = (
      projects: ReadonlyArray<{ id: string; createdAt: string }>,
    ) =>
      [...projects]
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .map(({ id }) => id);
    const adaList = await read(await list(ada.cookie));
    const bobList = await read(await list(bob.cookie));
    assert({
      given: 'two members with three projects each',
      should:
        'answer each member only their own projects, newest first (created_at desc, id desc)',
      actual: {
        ada: [adaList.status, adaList.body.projects!.map(({ id }) => id)],
        bob: [bobList.status, bobList.body.projects!.map(({ id }) => id)],
        adaNames: adaList.body.projects!.map(({ name }) => name),
      },
      expected: {
        ada: [200, newestFirst(created.ada!)],
        bob: [200, newestFirst(created.bob!)],
        adaNames: ['ada 3', 'ada 2', 'ada 1'],
      },
    });
  });

  test('an anonymous or provisional GET answers NOT_FOUND', async () => {
    const pending = await provisionalAccount();
    const anonymous = await read(await list(null));
    const provisional = await read(await list(pending.cookie));
    assert({
      given: 'no session, and a session without a username',
      should: 'answer 404 NOT_FOUND, exactly like a missing resource',
      actual: [
        [anonymous.status, anonymous.body.error?.code],
        [provisional.status, provisional.body.error?.code],
      ],
      expected: [
        [404, 'NOT_FOUND'],
        [404, 'NOT_FOUND'],
      ],
    });
  });
});
