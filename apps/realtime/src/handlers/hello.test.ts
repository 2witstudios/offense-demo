import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { ENVELOPE_VERSION, PROTOCOL_VERSION } from '@offense-demo/protocol';
import { evaluateFirstMessage } from './hello';

setupRitewayBun();

const validTicket = 'a'.repeat(43);
const validId = 'a'.repeat(24);

describe('evaluateFirstMessage', () => {
  test('closes protocol_unsupported for a frame that is not JSON', () => {
    assert({
      given: 'a first frame that fails to parse as JSON',
      should: 'close 4003 protocol_unsupported',
      actual: evaluateFirstMessage('not json'),
      expected: { code: 4003, reason: 'protocol_unsupported' },
    });
  });

  test('closes protocol_unsupported for JSON that fails the envelope schema', () => {
    assert({
      given: 'valid JSON that is not a recognized client message',
      should: 'close 4003 protocol_unsupported',
      actual: evaluateFirstMessage(
        JSON.stringify({ v: ENVELOPE_VERSION, type: 'unknown' }),
      ),
      expected: { code: 4003, reason: 'protocol_unsupported' },
    });
  });

  test('closes auth_failed for a valid message sent before hello', () => {
    const ping = JSON.stringify({
      v: ENVELOPE_VERSION,
      type: 'ping',
      id: validId,
    });

    assert({
      given: 'a well-formed ping sent as the first message',
      should:
        'close 4001 auth_failed, since every message before hello is rejected',
      actual: evaluateFirstMessage(ping),
      expected: { code: 4001, reason: 'auth_failed' },
    });
  });

  test('closes auth_failed for a well-formed hello, since ticket consumption is not built yet', () => {
    const hello = JSON.stringify({
      v: ENVELOPE_VERSION,
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      ticket: validTicket,
    });

    assert({
      given: 'a well-formed hello (RT-2.4b owns real ticket validation)',
      should: 'close 4001 auth_failed rather than accept the connection',
      actual: evaluateFirstMessage(hello),
      expected: { code: 4001, reason: 'auth_failed' },
    });
  });
});
