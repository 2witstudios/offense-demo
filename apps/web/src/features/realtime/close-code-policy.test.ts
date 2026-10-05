import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { decideOnClose } from './close-code-policy';

setupRitewayBun();

describe('decideOnClose (ADR 0031 §8 close-code table)', () => {
  test('4001 auth_failed: fetch a fresh ticket and reconnect, standard backoff', () => {
    assert({
      given: 'code 4001 with no prior consecutive auth failures',
      should: 'reconnect, refreshing the ticket, with standard backoff',
      actual: decideOnClose({ code: 4001, consecutiveAuthFailures: 0 }),
      expected: {
        reconnect: true,
        refreshTicket: true,
        backoffKind: 'standard',
        terminal: null,
      },
    });
  });

  test('4001 three times in a row stops reconnecting and reports signed-out', () => {
    assert({
      given:
        'code 4001 with 2 prior consecutive auth failures (this is the 3rd)',
      should: 'not reconnect, terminal signed-out',
      actual: decideOnClose({ code: 4001, consecutiveAuthFailures: 2 }),
      expected: {
        reconnect: false,
        refreshTicket: false,
        backoffKind: null,
        terminal: 'signed-out',
      },
    });
  });

  test('4002 revoked: never reconnect', () => {
    assert({
      given: 'code 4002',
      should: 'not reconnect, terminal revoked',
      actual: decideOnClose({ code: 4002, consecutiveAuthFailures: 0 }),
      expected: {
        reconnect: false,
        refreshTicket: false,
        backoffKind: null,
        terminal: 'revoked',
      },
    });
  });

  test('4003 protocol_unsupported: never reconnect', () => {
    assert({
      given: 'code 4003',
      should: 'not reconnect, terminal unsupported',
      actual: decideOnClose({ code: 4003, consecutiveAuthFailures: 0 }),
      expected: {
        reconnect: false,
        refreshTicket: false,
        backoffKind: null,
        terminal: 'unsupported',
      },
    });
  });

  test('4004 rate_limited: reconnect with a 30s-floor backoff', () => {
    assert({
      given: 'code 4004',
      should: 'reconnect, no ticket refresh, rate-limited backoff',
      actual: decideOnClose({ code: 4004, consecutiveAuthFailures: 0 }),
      expected: {
        reconnect: true,
        refreshTicket: false,
        backoffKind: 'rate-limited',
        terminal: null,
      },
    });
  });

  test('4005 slow_consumer: reconnect with jitter, standard backoff', () => {
    assert({
      given: 'code 4005',
      should: 'reconnect, no ticket refresh, standard backoff',
      actual: decideOnClose({ code: 4005, consecutiveAuthFailures: 0 }),
      expected: {
        reconnect: true,
        refreshTicket: false,
        backoffKind: 'standard',
        terminal: null,
      },
    });
  });

  test('4006 server_restarting: reconnect immediately (0-5s jitter)', () => {
    assert({
      given: 'code 4006',
      should: 'reconnect, no ticket refresh, immediate backoff',
      actual: decideOnClose({ code: 4006, consecutiveAuthFailures: 0 }),
      expected: {
        reconnect: true,
        refreshTicket: false,
        backoffKind: 'immediate',
        terminal: null,
      },
    });
  });

  test('1000 normal and 1001 going away: reconnect only when still wanted, standard backoff', () => {
    assert({
      given: 'codes 1000 and 1001',
      should:
        'reconnect (the caller gates on whether it still wants the socket)',
      actual: [1000, 1001].map(
        (code) => decideOnClose({ code, consecutiveAuthFailures: 0 }).reconnect,
      ),
      expected: [true, true],
    });
  });

  test('1006 abnormal and any unknown code: reconnect with standard backoff', () => {
    assert({
      given: 'code 1006 and an unrecognized code 4999',
      should: 'reconnect with standard jittered backoff',
      actual: [1006, 4999].map((code) =>
        decideOnClose({ code, consecutiveAuthFailures: 0 }),
      ),
      expected: [
        {
          reconnect: true,
          refreshTicket: false,
          backoffKind: 'standard',
          terminal: null,
        },
        {
          reconnect: true,
          refreshTicket: false,
          backoffKind: 'standard',
          terminal: null,
        },
      ],
    });
  });
});
