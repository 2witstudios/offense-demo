import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import {
  OUTBOX_ORIGIN,
  appendOutboxEvent,
  decodeOutboxCursor,
  drainOutbox,
  encodeOutboxCursor,
  readOutboxHighWaterMark,
} from './outbox';

setupRitewayBun();

describe('outbox cursor', () => {
  test('round-trips a position through the opaque string', () => {
    const position = { txid: '1042', seq: 7n };
    const decoded = decodeOutboxCursor(encodeOutboxCursor(position));
    assert({
      given: 'a position encoded to an opaque cursor',
      should: 'decode back to the same txid and seq',
      actual: decoded,
      expected: position,
    });
  });

  test('the origin cursor decodes from its own encoding', () => {
    const decoded = decodeOutboxCursor(encodeOutboxCursor(OUTBOX_ORIGIN));
    assert({
      given: 'the origin position',
      should: 'round-trip to txid "0" and seq 0n',
      actual: decoded,
      expected: OUTBOX_ORIGIN,
    });
  });

  test('refuses a cursor that is not shaped like the protocol txid:seq position', () => {
    const attempts = [
      '',
      'not-a-position',
      '1042.7',
      '1042:',
      ':7',
      '01:7',
      '1042:07',
      '1042:-7',
    ].map((value) => {
      try {
        decodeOutboxCursor(value);
        return 'accepted';
      } catch {
        return 'refused';
      }
    });
    assert({
      given: 'empty text, garbage, and malformed txid:seq shapes',
      should: 'refuse every one instead of returning a bogus position',
      actual: attempts,
      expected: attempts.map(() => 'refused'),
    });
  });

  test('refuses a non-string cursor', () => {
    const outcome = (() => {
      try {
        decodeOutboxCursor(42);
        return 'accepted';
      } catch {
        return 'refused';
      }
    })();
    assert({
      given: 'a cursor that is not a string',
      should: 'refuse it',
      actual: outcome,
      expected: 'refused',
    });
  });

  test('refuses a txid or seq outside their real 64-bit column ranges', () => {
    const attempts = [
      `${2n ** 64n}:1`, // txid overflows unsigned 64-bit (xid8)
      `1:${2n ** 63n}`, // seq overflows signed 64-bit (bigserial)
    ].map((value) => {
      try {
        decodeOutboxCursor(value);
        return 'accepted';
      } catch {
        return 'refused';
      }
    });
    assert({
      given: 'a txid past xid8 range and a seq past bigserial range',
      should: 'refuse each as a validation error, never reach the database',
      actual: attempts,
      expected: attempts.map(() => 'refused'),
    });
  });
});

/** A transaction that records, and refuses, any insert or execute. */
const untouchableTx = () => {
  let touched = false;
  const refuse = () => {
    touched = true;
    throw new Error('should not be called');
  };
  return { tx: { insert: refuse, execute: refuse }, touched: () => touched };
};

describe('appendOutboxEvent input validation', () => {
  test('refuses a payload missing required shape before touching the database', async () => {
    const { tx, touched } = untouchableTx();
    // Every case below otherwise carries a real, storable topic/kind/payload
    // pair (RT-2.2f-r2 review minor): a `payload: {}` shared across every
    // case would already fail `outboxPayloadSchema` on its own, so the test
    // would keep passing even if the topic/kind/version/strictObject rules
    // on `outboxAppendInputSchema` were loosened away. Only the one field
    // named per case is invalid.
    const userId = createId();
    const topic = buildUserInboxTopic(userId);
    const kind = 'session.revoked' as const;
    const payload = { entityVersion: 1, kind, ids: [userId] };
    const attempts = await Promise.all(
      [
        { topic: '', kind, version: 1, payload },
        { topic, kind: '', version: 1, payload },
        { topic, kind, version: 0, payload },
        { topic, kind, version: 1.5, payload },
        { topic, kind, version: 1, payload, extra: 'nope' },
      ].map((input) =>
        // biome-ignore-next: exercising the runtime boundary with bad shapes
        appendOutboxEvent(tx as never, input as never)
          .then(() => 'accepted')
          .catch(() => 'refused'),
      ),
    );
    assert({
      given:
        'an empty topic/kind, a non-positive or fractional version, and an unknown field, each next to an otherwise valid and storable topic/kind/payload',
      should: 'refuse every one without inserting or notifying',
      actual: { attempts, touched: touched() },
      expected: {
        attempts: attempts.map(() => 'refused'),
        touched: false,
      },
    });
  });

  test('refuses a non-object payload before touching the database', async () => {
    const { tx, touched } = untouchableTx();
    const attempts = await Promise.all(
      [null, 'a string', 42, true, ['array', 'not', 'object']].map((payload) =>
        appendOutboxEvent(
          tx as never,
          {
            topic: 't',
            kind: 'k',
            version: 1,
            payload,
          } as never,
        )
          .then(() => 'accepted')
          .catch(() => 'refused'),
      ),
    );
    assert({
      given: 'null, a string, a number, a boolean and an array as payload',
      should:
        'refuse every one as a clean validation error, never reaching the outbox_payload_is_object CHECK',
      actual: { attempts, touched: touched() },
      expected: {
        attempts: attempts.map(() => 'refused'),
        touched: false,
      },
    });
  });
});

describe('appendOutboxEvent storage-side family rule (RT-2.1c, plan revision 4.11)', () => {
  const fakeTx = () => {
    const calls: unknown[] = [];
    return {
      tx: {
        insert: (_table: unknown) => ({
          values: (_values: unknown) => ({
            returning: async (_columns: unknown) => {
              calls.push('insert');
              return [{ seq: 1n, txid: '1' }];
            },
          }),
        }),
        execute: async (query: unknown) => {
          calls.push(query);
          return [{ seq: 1n, txid: '1' }];
        },
      },
      calls,
    };
  };

  test('accepts a session.revoked control row on the user inbox family, and refuses a doorbell kind that family disallows', async () => {
    const userId = createId();
    const topic = buildUserInboxTopic(userId);

    const allowed = fakeTx();
    const allowedResult = await appendOutboxEvent(allowed.tx as never, {
      topic,
      kind: 'session.revoked',
      version: 1,
      payload: { entityVersion: 1, kind: 'session.revoked', ids: [userId] },
    })
      .then(() => 'accepted')
      .catch(() => 'refused');

    const disallowed = fakeTx();
    const disallowedResult = await appendOutboxEvent(disallowed.tx as never, {
      topic,
      kind: 'room.changed',
      version: 1,
      payload: { entityVersion: 1, kind: 'room.changed', ids: [userId] },
    })
      .then(() => 'accepted')
      .catch(() => 'refused');

    assert({
      given:
        "a session.revoked control row on a user's inbox topic, and a room.changed doorbell on that same topic",
      should:
        'accept the control kind the storage-side family rule allows on the inbox, and refuse the one it does not before touching the database',
      actual: {
        allowedResult,
        allowedTouchedDatabase: allowed.calls.length > 0,
        disallowedResult,
        disallowedTouchedDatabase: disallowed.calls.length > 0,
      },
      expected: {
        allowedResult: 'accepted',
        allowedTouchedDatabase: true,
        disallowedResult: 'refused',
        disallowedTouchedDatabase: false,
      },
    });
  });

  test('refuses a row whose kind column disagrees with its payload kind, before touching the database', async () => {
    const userId = createId();
    const topic = buildUserInboxTopic(userId);
    const mismatched = fakeTx();
    const result = await appendOutboxEvent(mismatched.tx as never, {
      topic,
      kind: 'bogus.kind',
      version: 1,
      payload: { entityVersion: 1, kind: 'session.revoked', ids: [userId] },
    })
      .then(() => 'accepted')
      .catch(() => 'refused');
    assert({
      given:
        'an append whose kind column ("bogus.kind") differs from its payload.kind ("session.revoked")',
      should:
        'refuse it before touching the database, since consumers and cleanups filter on the kind column',
      actual: { result, touchedDatabase: mismatched.calls.length > 0 },
      expected: { result: 'refused', touchedDatabase: false },
    });
  });
});

describe('drainOutbox limit validation', () => {
  test('refuses a limit outside the bounded range', async () => {
    const db = { execute: () => Promise.reject(new Error('should not run')) };
    const attempts = await Promise.all(
      [0, -1, 1.5, 501].map((limit) =>
        drainOutbox(db as never, OUTBOX_ORIGIN, limit)
          .then(() => 'accepted')
          .catch(() => 'refused'),
      ),
    );
    assert({
      given: 'zero, negative, fractional and over-the-cap limits',
      should: 'refuse every one without querying',
      actual: attempts,
      expected: attempts.map(() => 'refused'),
    });
  });
});

describe('readOutboxHighWaterMark (RT-2.3b startup read, ADR 0032 §2)', () => {
  test('returns the origin when the outbox has no final row yet', async () => {
    const db = { execute: async () => [] };
    assert({
      given: 'an empty result (no row is final yet)',
      should: 'return the origin position rather than a bogus one',
      actual: await readOutboxHighWaterMark(db as never),
      expected: OUTBOX_ORIGIN,
    });
  });

  test('decodes the returned row into a position', async () => {
    const db = { execute: async () => [{ txid: '1042', seq: '7' }] };
    assert({
      given: 'the greatest final (txid, seq) row',
      should: 'decode it into an OutboxPosition',
      actual: await readOutboxHighWaterMark(db as never),
      expected: { txid: '1042', seq: 7n },
    });
  });
});
