import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { ClaimOutcome } from './claim-username';
import {
  claimUnavailable,
  refusesShape,
  shownNotice,
  submitClaim,
} from './claim-form';

setupRitewayBun();

const posted = (username?: string | Blob) => {
  const form = new FormData();
  if (username !== undefined) form.set('username', username);
  return form;
};

const answering = (outcome: ClaimOutcome | Error) => {
  const asked: string[] = [];
  const claim = async (username: string) => {
    asked.push(username);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { asked, claim };
};

describe('submitClaim', () => {
  test('a claimed name moves on', async () => {
    const { asked, claim } = answering({ kind: 'claimed', username: 'ada' });
    assert({
      given: 'a well-formed name the server claims',
      should: 'claim exactly the posted name and report claimed',
      actual: [await submitClaim(claim, posted('Ada')), asked],
      expected: [{ kind: 'claimed' }, ['Ada']],
    });
  });

  test('an account that already has a name moves on', async () => {
    const { claim } = answering({ kind: 'already-set' });
    assert({
      given: 'a claim the server answers with already-set',
      should: 'report already-set, not a refusal',
      actual: await submitClaim(claim, posted('ada')),
      expected: { kind: 'already-set' },
    });
  });

  test('a refused claim keeps what was typed and explains', async () => {
    const outcomes = [
      'taken',
      'signed-out',
      'rate-limited',
      'unavailable',
      'invalid',
    ] as const;
    const actual = await Promise.all(
      outcomes.map((kind) =>
        submitClaim(answering({ kind }).claim, posted('Ada')),
      ),
    );
    assert({
      given: 'each refusal the server can answer',
      should: 'return the typed name with that notice',
      actual,
      expected: outcomes.map((notice) => ({
        kind: 'refused' as const,
        state: { username: 'Ada', notice },
      })),
    });
  });

  test('a malformed name never reaches the claim', async () => {
    const { asked, claim } = answering({ kind: 'claimed', username: 'x' });
    assert({
      given: 'a name with spaces, a missing field and a file upload',
      should: 'refuse each as invalid without claiming',
      actual: [
        await submitClaim(claim, posted('a b')),
        await submitClaim(claim, posted()),
        await submitClaim(claim, posted(new Blob(['ada']))),
        asked,
      ],
      expected: [
        { kind: 'refused', state: { username: 'a b', notice: 'invalid' } },
        { kind: 'refused', state: { username: '', notice: 'invalid' } },
        { kind: 'refused', state: { username: '', notice: 'invalid' } },
        [],
      ],
    });
  });

  test('a claim that throws is unavailable, never a success', async () => {
    const { claim } = answering(new Error('boom'));
    assert({
      given: 'a claim seam that throws',
      should: 'refuse as unavailable and keep the typed name',
      actual: await submitClaim(claim, posted('ada')),
      expected: {
        kind: 'refused',
        state: { username: 'ada', notice: 'unavailable' },
      },
    });
  });
});

describe('claimUnavailable', () => {
  test('answers unavailable for the posted name', () => {
    assert({
      given: 'a posted form whose claim never reached the server',
      should:
        'refuse as unavailable with the name as typed, or an empty one for a file',
      actual: [
        claimUnavailable(posted('ada')),
        claimUnavailable(posted(new Blob(['x']))),
      ],
      expected: [
        { username: 'ada', notice: 'unavailable' },
        { username: '', notice: 'unavailable' },
      ],
    });
  });
});

describe('refusesShape', () => {
  test('checks the shape locally', () => {
    assert({
      given: 'a valid name, a spaced name and an empty one',
      should: 'refuse only the malformed ones',
      actual: [refusesShape('Ada_1'), refusesShape('a b'), refusesShape('')],
      expected: [false, true, true],
    });
  });
});

describe('shownNotice', () => {
  test('a local refusal wins, typing hides, otherwise the server speaks', () => {
    assert({
      given: 'no local override, a local refusal, and typing since the answer',
      should: 'show the server notice, the local one, then nothing',
      actual: [
        shownNotice({ local: undefined, answered: 'taken', pending: false }),
        shownNotice({ local: 'invalid', answered: 'taken', pending: false }),
        shownNotice({ local: 'edited', answered: 'taken', pending: false }),
      ],
      expected: ['taken', 'invalid', undefined],
    });
  });

  test('a pending claim shows no answer from before it (ISSUE-76)', () => {
    assert({
      given:
        'a refusal still held from the last claim while the next one is pending',
      should: 'show nothing until the new answer arrives',
      actual: shownNotice({
        local: undefined,
        answered: 'taken',
        pending: true,
      }),
      expected: undefined,
    });
  });
});
