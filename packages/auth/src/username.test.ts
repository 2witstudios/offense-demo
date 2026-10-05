import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { parseUsername } from './username';

setupRitewayBun();

describe('parseUsername', () => {
  test('trims and lowercases a valid name', () => {
    assert({
      given: 'a valid name with padding and capitals',
      should: 'return the trimmed lowercase name',
      actual: parseUsername('  Ada_Lovelace-1 '),
      expected: { ok: true, username: 'ada_lovelace-1' },
    });
  });

  test('enforces the 3 to 32 character bounds', () => {
    const outcome = (value: string) => parseUsername(value).ok;
    assert({
      given: 'names at and just outside each bound',
      should: 'accept 3 and 32 characters and refuse 2 and 33',
      actual: [
        outcome('abc'),
        outcome('ab'),
        outcome('a'.repeat(32)),
        outcome('a'.repeat(33)),
      ],
      expected: [true, false, true, false],
    });
  });

  test('accepts only ASCII letters, digits, underscore and hyphen', () => {
    const outcome = (value: unknown) => parseUsername(value).ok;
    assert({
      given: 'spaces, dots, at-signs, unicode and non-string input',
      should: 'refuse every one',
      actual: [
        outcome('a b c'),
        outcome('ada.l'),
        outcome('ada@x'),
        outcome('adá_l'),
        // U+212A KELVIN SIGN lowercases to ASCII "k"; it must not pass.
        outcome('Kelvin'),
        outcome('ada\nlovelace'),
        outcome(42),
        outcome(undefined),
      ],
      expected: [false, false, false, false, false, false, false, false],
    });
  });
});
