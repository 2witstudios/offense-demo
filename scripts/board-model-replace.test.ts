import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { checkReplace, contentHash } from './board-model';

setupRitewayBun();

describe('checkReplace', () => {
  const current = ['a', 'b', 'c', 'd'].join('\n');

  test('allows a replace when the page is unchanged', () => {
    assert({
      given: 'the expected line count and old text',
      should: 'allow it',
      actual: checkReplace(current, {
        start: 2,
        end: 3,
        expectLines: 4,
        oldText: 'b\nc',
      }),
      expected: undefined,
    });
  });

  test('refuses a replace whose expected hash is not the current content', () => {
    const input = { start: 2, end: 3, expectLines: 4 };
    assert({
      given: 'an expected hash of other content, then of the current content',
      should: 'refuse the first and allow the second',
      actual: [
        checkReplace(current, {
          ...input,
          expectHash: contentHash('a\nx\nc\nd'),
        }),
        checkReplace(current, { ...input, expectHash: contentHash(current) }),
      ],
      expected: [
        'The page changed since you read it (content hash differs). Read it again.',
        undefined,
      ],
    });
  });

  test('allows a whole-page replace of a page that ends with a newline', () => {
    const trailing = 'a\nb\n';
    assert({
      given: 'an unchanged page ending in a newline and its saved copy',
      should: 'allow it',
      actual: checkReplace(trailing, {
        start: 1,
        end: 3,
        expectLines: 3,
        oldText: trailing,
      }),
      expected: undefined,
    });
  });

  test('accepts an old-text file saved with a trailing newline', () => {
    assert({
      given:
        'lines 1-2 of a three-line page, saved to a file ending in a newline',
      should: 'match them, since editors end files with a newline',
      actual: checkReplace('a\nb\nc', {
        start: 1,
        end: 2,
        expectLines: 3,
        oldText: 'a\nb\n',
      }),
      expected: undefined,
    });
  });

  test('refuses a replace after a concurrent edit', () => {
    assert({
      given: 'a changed line count, changed old text, and an out-of-range end',
      should: 'refuse each with a reason',
      actual: [
        checkReplace(current, { start: 2, end: 3, expectLines: 5 }),
        checkReplace(current, {
          start: 2,
          end: 3,
          expectLines: 4,
          oldText: 'b\nX',
        }),
        checkReplace(current, { start: 2, end: 9, expectLines: 4 }),
      ],
      expected: [
        'The page has 4 lines, not 5: someone edited it. Read it again.',
        'Lines 2-3 changed since you read them. Read the page again.',
        'Lines 2-9 are outside the page (4 lines).',
      ],
    });
  });
});
