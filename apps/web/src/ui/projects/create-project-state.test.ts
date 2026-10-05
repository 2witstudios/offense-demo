import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { CreateOutcome, CreateProject } from './create-project';
import { createUnavailable, submitCreate } from './create-project-state';

setupRitewayBun();

const formWith = (entries: Record<string, string | Blob>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(entries)) form.set(name, value);
  return form;
};

/** A create that records what it was asked and answers `outcome`. */
const answering = (outcome: CreateOutcome | Error) => {
  const asked: string[] = [];
  const create: CreateProject = async (name) => {
    asked.push(name);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { asked, create };
};

describe('submitCreate', () => {
  test('a created project moves on', async () => {
    const { asked, create } = answering({ kind: 'created' });
    assert({
      given: 'a posted name the route created',
      should: 'ask the route for exactly the typed name and report created',
      actual: [
        await submitCreate(create, formWith({ name: ' Launch ' })),
        asked,
      ],
      expected: [{ kind: 'created' }, [' Launch ']],
    });
  });

  test('an invalid name comes back with the name as typed', async () => {
    const { create } = answering({ kind: 'invalid' });
    assert({
      given: 'a name the route refused as invalid',
      should: 'refuse with the typed name and the invalid notice',
      actual: await submitCreate(create, formWith({ name: '   ' })),
      expected: { kind: 'refused', state: { name: '   ', notice: 'invalid' } },
    });
  });

  test('the create ceiling and an unavailable route are their own states', async () => {
    const refusedWith = async (outcome: CreateOutcome | Error) =>
      submitCreate(answering(outcome).create, formWith({ name: 'Launch' }));
    assert({
      given: 'a throttled create, an unavailable route and a create that threw',
      should:
        'refuse each with the typed name kept: rate-limited, unavailable, unavailable',
      actual: [
        await refusedWith({ kind: 'rate-limited' }),
        await refusedWith({ kind: 'unavailable' }),
        await refusedWith(new Error('boom')),
      ],
      expected: [
        { kind: 'refused', state: { name: 'Launch', notice: 'rate-limited' } },
        { kind: 'refused', state: { name: 'Launch', notice: 'unavailable' } },
        { kind: 'refused', state: { name: 'Launch', notice: 'unavailable' } },
      ],
    });
  });

  test('a missing or non-text field is posted as an empty name', async () => {
    const { asked, create } = answering({ kind: 'invalid' });
    await submitCreate(create, new FormData());
    await submitCreate(create, formWith({ name: new Blob(['x']) }));
    assert({
      given: 'a form without a name field, and one whose name is a file',
      should: 'let the route judge an empty name',
      actual: asked,
      expected: ['', ''],
    });
  });
});

describe('createUnavailable', () => {
  test('keeps the typed name when the action call failed in transport', () => {
    assert({
      given: 'a posted form whose action call never answered',
      should: 'answer unavailable with the typed name',
      actual: createUnavailable(formWith({ name: 'Launch' })),
      expected: { name: 'Launch', notice: 'unavailable' },
    });
  });
});
