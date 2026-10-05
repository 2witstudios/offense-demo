import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { successRate, tally } from './metrics';
import type { WorkloadOutcome } from './workload';

setupRitewayBun();

const outcome = (
  kind: WorkloadOutcome['kind'],
  status: WorkloadOutcome['status'],
): WorkloadOutcome => ({ kind, status, latencyMs: 1 });

describe('successRate (AUTH-6.7 AC2/AC4, ISSUE-165)', () => {
  test('a healthy run with no rejections passes', () => {
    const outcomes: WorkloadOutcome[] = [
      ...Array.from({ length: 80 }, () => outcome('session-read', 200)),
      ...Array.from({ length: 10 }, () => outcome('magic-link', 303)),
      ...Array.from({ length: 10 }, () => outcome('passkey-assertion', 200)),
    ];
    const result = successRate(tally(outcomes));
    assert({
      given: '100 offered requests, all successful',
      should: 'report the full admitted count at 100% success',
      actual: { admitted: result.admitted, rate: result.rate },
      expected: { admitted: 100, rate: 1 },
    });
  });

  test("excludes only the magic-link segment's documented 429 ceiling from the admitted count", () => {
    const outcomes: WorkloadOutcome[] = [
      ...Array.from({ length: 85 }, () => outcome('session-read', 200)),
      ...Array.from({ length: 7 }, () => outcome('magic-link', 303)),
      ...Array.from({ length: 3 }, () => outcome('magic-link', 429)),
      ...Array.from({ length: 5 }, () => outcome('passkey-assertion', 200)),
    ];
    const result = successRate(tally(outcomes));
    assert({
      given:
        '3 deliberate magic-link 429s out of 100 offered, everything else successful',
      should:
        'exclude only those 3 from admitted (100 - 3 = 97) and pass at 100% of admitted',
      actual: { admitted: result.admitted, rate: result.rate },
      expected: { admitted: 97, rate: 1 },
    });
  });

  test('a 429 storm on session-read counts against the 99% bar instead of being excluded (ISSUE-165 regression)', () => {
    const outcomes: WorkloadOutcome[] = [
      ...Array.from({ length: 10 }, () => outcome('session-read', 200)),
      ...Array.from({ length: 990 }, () => outcome('session-read', 429)),
    ];
    const result = successRate(tally(outcomes));
    assert({
      given:
        '990 of 1000 session-read requests answered 429 (not the magic-link segment)',
      should:
        'count every one of the 990 against the 99% bar (admitted stays 1000, rate collapses to 1%)',
      actual: {
        admitted: result.admitted,
        ratePassesBar: result.rate >= 0.99,
      },
      expected: { admitted: 1000, ratePassesBar: false },
    });
  });

  test('a 429 storm on passkey-assertion also counts against the bar', () => {
    const outcomes: WorkloadOutcome[] = [
      ...Array.from({ length: 10 }, () => outcome('passkey-assertion', 200)),
      ...Array.from({ length: 990 }, () => outcome('passkey-assertion', 429)),
    ];
    const result = successRate(tally(outcomes));
    assert({
      given: '990 of 1000 passkey-assertion requests answered 429',
      should: 'fail the 99% bar',
      actual: result.rate >= 0.99,
      expected: false,
    });
  });

  test('zero offered requests reports zero admitted and a zero rate, never dividing by zero', () => {
    const result = successRate(tally([]));
    assert({
      given: 'no outcomes at all',
      should: 'report admitted 0 and rate 0',
      actual: result,
      expected: { admitted: 0, rate: 0 },
    });
  });
});
