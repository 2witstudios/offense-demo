import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  linkedPageIds,
  verifyReviewRecord as verifyWithRules,
} from './review-record';
import { pr, record, rules } from './review-record.test-support';

setupRitewayBun();

describe('review rules from project config', () => {
  test('the integration gate line follows gates.integrationCommand', () => {
    const clean = '0 blocker / 0 major / 0 minor / 0 nit — APPROVE';
    const custom = { ...rules, integrationCommand: 'make integration' };
    const withGates = (gates: string) => record({ verdict: clean, gates });
    assert({
      given:
        'a no-findings record under a configured integration command of make integration',
      should:
        'accept that command passing, refuse the default one, and name the configured command',
      actual: [
        verifyWithRules(
          pr,
          [
            withGates(
              'make integration: PASS (12 pass)\nNegative control run: yes',
            ),
          ],
          [],
          custom,
        ).state,
        verifyWithRules(
          pr,
          [
            withGates(
              'bun test:integration: PASS (12 pass)\nNegative control run: yes',
            ),
          ],
          [],
          custom,
        ).description,
      ],
      expected: [
        'success',
        'A no-findings verdict needs make integration PASS and a negative control in Gates run',
      ],
    });
  });

  test('page links follow the configured host and drive', () => {
    assert({
      given: 'a link on a self-hosted PageSpace instance',
      should: 'collect it only under that host',
      actual: [
        linkedPageIds(
          [
            `https://pages.example.com/dashboard/${rules.driveId}/rec1111111111111111111111`,
          ],
          { ...rules, apiUrl: 'https://pages.example.com' },
        ),
        linkedPageIds(
          [
            `https://pages.example.com/dashboard/${rules.driveId}/rec1111111111111111111111`,
          ],
          rules,
        ),
      ],
      expected: [['rec1111111111111111111111'], []],
    });
  });
});
