import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { SecurityOutcome } from '../../../features/account/security-client';
import {
  emailChangeNotice,
  refusesNewAddress,
  emailChangeUnavailable,
  submitEmailChange,
} from './email-change-state';

setupRitewayBun();

const recording = (answer: SecurityOutcome | Error) => {
  const asked: string[] = [];
  const change = async (newEmail: string) => {
    asked.push(newEmail);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { asked, change };
};

describe('submitEmailChange', () => {
  test('starts the change for the trimmed address and echoes it', async () => {
    const { asked, change } = recording({ kind: 'conflict' });
    const form = new FormData();
    form.set('newEmail', ' taken@example.test ');
    assert({
      given: 'a posted email-change form',
      should: 'request the trimmed address and answer with its outcome',
      actual: [await submitEmailChange(change, form), asked],
      expected: [
        { newEmail: 'taken@example.test', outcome: 'conflict' },
        ['taken@example.test'],
      ],
    });
  });

  test('reads an untrusted form defensively, and a throw is unavailable', async () => {
    const form = new FormData();
    form.set('newEmail', new Blob(['x']));
    assert({
      given: 'a file for the address, and a change that throws',
      should: 'use an empty address, and answer unavailable, never ok',
      actual: [
        await submitEmailChange(recording({ kind: 'invalid' }).change, form),
        await submitEmailChange(recording(new Error('down')).change, form),
      ],
      expected: [
        { newEmail: '', outcome: 'invalid' },
        { newEmail: '', outcome: 'unavailable' },
      ],
    });
  });
});

describe('emailChangeNotice', () => {
  test('says where the approval went, or why nothing started', () => {
    assert({
      given: 'no answer yet, an accepted change, and a conflict',
      should:
        'show nothing, then an approval notice, then the refusal as an error',
      actual: [
        emailChangeNotice({ newEmail: '' }),
        emailChangeNotice({ newEmail: 'a@b.test', outcome: 'ok' }),
        emailChangeNotice({ newEmail: 'a@b.test', outcome: 'conflict' }),
      ],
      expected: [
        undefined,
        {
          tone: 'info',
          title:
            'Check the inbox for the address currently on file to approve this change.',
        },
        { tone: 'error', title: 'That email is already in use.' },
      ],
    });
  });
});

describe('emailChangeNotice for an undeliverable address (ISSUE-113)', () => {
  test('says which address cannot receive email, and only asks for another new one when that helps', () => {
    const answer = (outcome: 'undeliverable' | 'current-undeliverable') => ({
      notice: emailChangeNotice({ newEmail: 'a@b.test', outcome }),
      refusesNewAddress: refusesNewAddress({ newEmail: 'a@b.test', outcome }),
    });
    assert({
      given:
        'a refusal because the new address cannot receive email, then because the address on file cannot',
      should:
        'ask for a different new address and mark the field, then explain the approval cannot be emailed without blaming the new address',
      actual: [answer('undeliverable'), answer('current-undeliverable')],
      expected: [
        {
          notice: {
            tone: 'error',
            title:
              'We cannot send email to that address. Use a different address.',
          },
          refusesNewAddress: true,
        },
        {
          notice: {
            tone: 'error',
            title:
              'We cannot send email to the address on file, so this change cannot be approved by email.',
          },
          refusesNewAddress: false,
        },
      ],
    });
  });

  test('marks the field only for an undeliverable new address', () => {
    assert({
      given: 'no answer, an accepted change and every other refusal',
      should: 'leave the field valid',
      actual: (
        [
          undefined,
          'ok',
          'stale-session',
          'conflict',
          'rate-limited',
          'invalid',
          'unavailable',
        ] as const
      ).map((outcome) =>
        refusesNewAddress(
          outcome === undefined
            ? { newEmail: '' }
            : { newEmail: 'a@b.test', outcome },
        ),
      ),
      expected: [false, false, false, false, false, false, false],
    });
  });
});

describe('emailChangeUnavailable', () => {
  test('answers unavailable for the posted address', () => {
    const typed = new FormData();
    typed.set('newEmail', ' ada@example.test ');
    const file = new FormData();
    file.set('newEmail', new Blob(['x']));
    assert({
      given: 'a posted form whose change never reached the server',
      should:
        'answer unavailable with the trimmed address, or an empty one for a file',
      actual: [emailChangeUnavailable(typed), emailChangeUnavailable(file)],
      expected: [
        { newEmail: 'ada@example.test', outcome: 'unavailable' },
        { newEmail: '', outcome: 'unavailable' },
      ],
    });
  });
});
