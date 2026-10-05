import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { closeCodeTable } from './close-codes';

setupRitewayBun();

describe('close codes', () => {
  test('documents the close-code taxonomy exactly as ADR 0031 §8 fixes it', () => {
    assert({
      given: 'the close-code table',
      should: 'assign the ADR-fixed code to each reason',
      actual: closeCodeTable.map(({ code, reason }) => [reason, code]),
      expected: [
        ['auth_failed', 4001],
        ['revoked', 4002],
        ['protocol_unsupported', 4003],
        ['rate_limited', 4004],
        ['slow_consumer', 4005],
        ['server_restarting', 4006],
      ],
    });
  });
});
