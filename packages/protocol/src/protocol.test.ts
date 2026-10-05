import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { errorSchema, idSchema } from './index';
import { parseOutcome } from './parse-outcome.test-support';

setupRitewayBun();

const id = 'k2v9x0f4m8q3w1z7c5n6b4d2';

describe('identifier shape', () => {
  test('accepts a cuid2 identifier unchanged', () => {
    assert({
      given: 'a 24-character lowercase cuid2',
      should: 'accept it unchanged',
      actual: parseOutcome(idSchema, id),
      expected: { data: id },
    });
  });

  test('accepts exactly cuid2 and rejects every other identifier form', () => {
    const rejections = [
      ['a canonical legacy UUID', '0f0e6d1c-2b3a-4455-9a8b-7c6d5e4f3a21'],
      ['an uppercase UUID', '0F0E6D1C-2B3A-4455-9A8B-7C6D5E4F3A21'],
      ['a UUID without dashes', '0f0e6d1c2b3a44559a8b7c6d5e4f3a21'],
      ['a braced UUID', '{0f0e6d1c-2b3a-4455-9a8b-7c6d5e4f3a21}'],
      ['a 23-character truncated cuid2', id.slice(1)],
      ['a 25-character padded id', `${id}a`],
      ['an uppercase cuid2', id.toUpperCase()],
      ['an empty identifier', ''],
      ['an arbitrary string', 'not-an-identifier'],
      ['an identifier with spaces', `${id} `],
    ] as const;
    for (const [given, identifier] of rejections)
      assert({
        given: `an id that is ${given}`,
        should: 'reject it at the trust boundary',
        actual: parseOutcome(idSchema, identifier),
        expected: { issues: ['(root)'] },
      });
  });
});

describe('error schema', () => {
  test('accepts a stable invariant identity on invariant errors', () => {
    const invariantError = {
      version: 1,
      type: 'error',
      code: 'INVARIANT',
      message: 'Domain operation is not allowed',
      requestId: 'request-1',
      invariantId: 'room.membership.requires-invitation',
    };
    assert({
      given: 'a version 1 invariant error with its registered identity',
      should: 'accept the portable error contract',
      actual: parseOutcome(errorSchema, invariantError),
      expected: { data: invariantError },
    });
  });

  test('accepts the payload-too-large code', () => {
    const tooLarge = {
      version: 1,
      type: 'error',
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body too large',
      requestId: 'request-1',
    };
    assert({
      given: 'a version 1 error reporting an oversized request body',
      should: 'accept the portable error contract',
      actual: parseOutcome(errorSchema, tooLarge),
      expected: { data: tooLarge },
    });
  });

  test('rejects an unknown code, extra fields and a blank invariant identity', () => {
    const base = {
      version: 1,
      type: 'error',
      code: 'NOT_FOUND',
      message: 'Not found',
      requestId: 'request-1',
    };
    assert({
      given:
        'an error with an unknown code, an unknown field, or a blank invariant id',
      should: 'reject each one at the offending path',
      actual: [
        parseOutcome(errorSchema, { ...base, code: 'TEAPOT' }),
        parseOutcome(errorSchema, { ...base, stack: 'at foo()' }),
        parseOutcome(errorSchema, { ...base, invariantId: '   ' }),
      ],
      expected: [
        { issues: ['code'] },
        { issues: ['(root)'] },
        { issues: ['invariantId'] },
      ],
    });
  });
});
