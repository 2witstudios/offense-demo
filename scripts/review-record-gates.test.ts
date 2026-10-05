// Gate-line Markdown tolerance (ISSUE-122): a Gates run line decorated with
// a leading list bullet, backticks or bold reads the same as the plain
// line, while "not run" or "?" must still never count, however decorated.
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { pr, record, verifyReviewRecord } from './review-record.test-support';

setupRitewayBun();

const clean = '0 blocker / 0 major / 0 minor / 0 nit — APPROVE';

describe('gateLine Markdown tolerance', () => {
  test('reads a Gates run line decorated as Markdown the same as the plain line', () => {
    const bulleted = record({
      verdict: clean,
      gates: [
        '- `bun test:integration`: PASS (165 pass, 0 fail)',
        '- **Negative control run: yes** (below)',
      ].join('\n'),
    });
    const numbered = record({
      verdict: clean,
      gates: [
        '1. bun test:integration: PASS (165 pass, 0 fail)',
        '2. Negative control run: yes (below)',
      ].join('\n'),
    });
    assert({
      given:
        'the #102 backtick line, a bulleted line, and a numbered list line',
      should: 'pass the same as an undecorated Gates run line',
      actual: [
        verifyReviewRecord(pr, [bulleted]).state,
        verifyReviewRecord(pr, [numbered]).state,
      ],
      expected: ['success', 'success'],
    });
  });

  test('never counts a decorated line that says not run or carries a question mark', () => {
    const questioned = record({
      verdict: clean,
      gates: [
        '- `bun test:integration`: PASS?',
        '- Negative control run: yes',
      ].join('\n'),
    });
    const notRun = record({
      verdict: clean,
      gates: [
        '- **bun test:integration: not run**',
        '- Negative control run: yes',
      ].join('\n'),
    });
    const outsideGates = record({
      verdict: clean,
      gates: 'bun check: PASS',
      findings: '- `bun test:integration`: PASS\n- Negative control run: yes',
    });
    assert({
      given:
        'a decorated PASS with a question mark, a decorated not-run line, and a decorated gate quoted outside Gates run',
      should: 'still fail every one',
      actual: [
        verifyReviewRecord(pr, [questioned]).state,
        verifyReviewRecord(pr, [notRun]).state,
        verifyReviewRecord(pr, [outsideGates]).state,
      ],
      expected: ['failure', 'failure', 'failure'],
    });
  });
});
