import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createCreateProject } from './create-project';

setupRitewayBun();

/** A fetch that answers `response` once and keeps the request it was sent. */
function answering(response: Response | Error) {
  let sent: { url: string; init?: RequestInit } | undefined;
  const create = createCreateProject(async (url, init) => {
    sent = { url, init };
    if (response instanceof Error) throw response;
    return response;
  });
  return { create, sent: () => sent };
}

const created = Response.json(
  {
    project: {
      id: 'p1',
      name: 'Launch',
      status: 'active',
      createdAt: '2026-10-05T09:30:00.000Z',
      updatedAt: '2026-10-05T09:30:00.000Z',
    },
  },
  { status: 201 },
);

const refusal = (status: number, error: Record<string, string>) =>
  Response.json({ error: { version: 1, type: 'error', ...error } }, { status });

describe('createCreateProject', () => {
  test('posts exactly the name and reports the created project', async () => {
    const { create, sent } = answering(created);
    assert({
      given: 'a 201 from POST /api/projects',
      should: 'post only { name } as JSON and report created',
      actual: [
        await create(' Launch '),
        sent()?.url,
        sent()?.init?.method,
        new Headers(sent()?.init?.headers).get('content-type'),
        sent()?.init?.body,
      ],
      expected: [
        { kind: 'created' },
        '/api/projects',
        'POST',
        'application/json',
        '{"name":" Launch "}',
      ],
    });
  });

  test('maps each refusal to its outcome', async () => {
    const outcome = async (response: Response | Error) =>
      (await answering(response).create('Launch')).kind;
    assert({
      given:
        'the name invariant, a rejected body, the create ceiling, another invariant, a refused identity, 5xx, a malformed 201 and a network failure',
      should:
        'read the name invariant and a rejected body as invalid, the ceiling as rate-limited and everything else as unavailable',
      actual: [
        await outcome(
          refusal(422, {
            code: 'INVARIANT',
            invariantId: 'project.name.valid',
          }),
        ),
        await outcome(refusal(400, { code: 'VALIDATION' })),
        await outcome(refusal(429, { code: 'RATE_LIMIT' })),
        await outcome(
          refusal(422, {
            code: 'INVARIANT',
            invariantId: 'project.archived.terminal',
          }),
        ),
        await outcome(new Response('not json', { status: 422 })),
        await outcome(refusal(404, { code: 'NOT_FOUND' })),
        await outcome(refusal(403, { code: 'AUTHORIZATION' })),
        await outcome(refusal(503, { code: 'INFRASTRUCTURE' })),
        await outcome(new Response('not json', { status: 201 })),
        await outcome(new Error('offline')),
      ],
      expected: [
        'invalid',
        'invalid',
        'rate-limited',
        'unavailable',
        'unavailable',
        'unavailable',
        'unavailable',
        'unavailable',
        'unavailable',
        'unavailable',
      ],
    });
  });
});
