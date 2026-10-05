import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

import { isIsoDate, reviewDateStatus, utcToday } from './review-date';

setupRitewayBun();

describe('isIsoDate', () => {
  test('calendar validation', () => {
    assert({
      given: 'a real YYYY-MM-DD calendar day',
      should: 'accept it',
      actual: isIsoDate('2026-02-28'),
      expected: true,
    });
    assert({
      given: 'a well-shaped day the calendar does not contain',
      should: 'reject it instead of letting Date roll it forward',
      actual: [isIsoDate('2026-02-30'), isIsoDate('2026-13-01')],
      expected: [false, false],
    });
    assert({
      given: 'a timestamp, a loose date, or a non-string value',
      should: 'reject everything that is not exactly YYYY-MM-DD',
      actual: [
        isIsoDate('2026-02-28T00:00:00Z'),
        isIsoDate('2026-2-8'),
        isIsoDate('soon'),
        isIsoDate(''),
        isIsoDate(20260228),
        isIsoDate(undefined),
        isIsoDate(null),
      ],
      expected: [false, false, false, false, false, false, false],
    });
  });
});

describe('reviewDateStatus', () => {
  test('expiry against an injected day', () => {
    assert({
      given: 'a review date after today',
      should: 'be live',
      actual: reviewDateStatus('2026-10-01', '2026-09-20'),
      expected: 'live',
    });
    assert({
      given: 'a review date equal to today',
      should: 'stay live through its own day',
      actual: reviewDateStatus('2026-09-20', '2026-09-20'),
      expected: 'live',
    });
    assert({
      given: 'a review date before today',
      should: 'be expired',
      actual: reviewDateStatus('2026-09-19', '2026-09-20'),
      expected: 'expired',
    });
    assert({
      given: 'a malformed or missing review date',
      should: 'be invalid rather than silently live or expired',
      actual: [
        reviewDateStatus('2026-02-30', '2026-09-20'),
        reviewDateStatus('never', '2026-09-20'),
        reviewDateStatus(undefined, '2026-09-20'),
      ],
      expected: ['invalid', 'invalid', 'invalid'],
    });
  });
});

describe('utcToday', () => {
  test('UTC calendar day', () => {
    assert({
      given: 'an injected instant late in the UTC day',
      should: 'return that UTC calendar day as YYYY-MM-DD',
      actual: utcToday(new Date('2026-09-20T23:59:59.999Z')),
      expected: '2026-09-20',
    });
    assert({
      given: 'no injected instant',
      should: 'return a valid ISO day from the ambient clock',
      actual: isIsoDate(utcToday()),
      expected: true,
    });
  });
});
