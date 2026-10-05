import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { assertRejects } from '@offense-demo/errors/testing';
import { projectListFrom } from './project-list-response';

setupRitewayBun();

const dto = {
  id: 'p1',
  name: 'Launch',
  status: 'active',
  createdAt: '2026-10-05T09:30:00.000Z',
  updatedAt: '2026-10-05T09:30:00.000Z',
};

describe('projectListFrom', () => {
  test('reads the rendered fields of each project, keeping the route’s order', async () => {
    const second = { ...dto, id: 'p0', name: 'Older' };
    assert({
      given: 'a 200 GET /api/projects answer',
      should: 'return each project’s id, name and created date in order',
      actual: await projectListFrom(Response.json({ projects: [dto, second] })),
      expected: [
        { id: 'p1', name: 'Launch', createdAt: '2026-10-05T09:30:00.000Z' },
        { id: 'p0', name: 'Older', createdAt: '2026-10-05T09:30:00.000Z' },
      ],
    });
  });

  test('reads an empty list as no projects', async () => {
    assert({
      given: 'a member with no projects',
      should: 'return an empty list',
      actual: await projectListFrom(Response.json({ projects: [] })),
      expected: [],
    });
  });

  test('fails closed on a refused read', async () => {
    await assertRejects({
      given: 'a GET /api/projects that answered 404',
      should: 'reject as INTERNAL rather than render an empty list',
      actual: () =>
        projectListFrom(
          Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }),
        ),
      code: 'INTERNAL',
    });
  });

  test('fails closed on an answer that is not the list shape', async () => {
    await assertRejects({
      given: 'a 200 answer without a projects array',
      should: 'reject as INTERNAL',
      actual: () =>
        projectListFrom(Response.json({ projects: [{ id: 'p1' }] })),
      code: 'INTERNAL',
    });
  });
});
