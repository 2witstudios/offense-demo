import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  isPayloadStorableOnTopic,
  outboxPayloadSchema,
} from './realtime-payloads';
import { parseOutcome } from './parse-outcome.test-support';

setupRitewayBun();

const id = 'k2v9x0f4m8q3w1z7c5n6b4d2';
const otherId = 'm8q3w1z7c5n6b4d2k2v9x0f4';

describe('outbox payload schema', () => {
  test('never accepts room.presence-changed as a doorbell kind: presence is never written to the outbox', () => {
    assert({
      given:
        'a doorbell payload of each outbox doorbell kind and the presence kind',
      should: 'accept exactly the doorbell kind delivered through the outbox',
      actual: ['room.changed', 'room.presence-changed'].map((kind) =>
        parseOutcome(outboxPayloadSchema, {
          entityVersion: 1,
          kind,
          ids: [id],
        }),
      ),
      expected: [
        { data: { entityVersion: 1, kind: 'room.changed', ids: [id] } },
        { issues: ['kind'] },
      ],
    });
  });

  test('validates a doorbell payload by kind and entity version', () => {
    assert({
      given: 'a version 1 doorbell payload naming a known kind',
      should: 'accept it',
      actual: parseOutcome(outboxPayloadSchema, {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: {
        data: {
          entityVersion: 1,
          kind: 'room.changed',
          ids: [id],
        },
      },
    });
    assert({
      given: 'a payload with an unknown kind',
      should: 'reject it',
      actual: parseOutcome(outboxPayloadSchema, {
        entityVersion: 2,
        kind: 'room.exploded',
        ids: [id],
      }),
      expected: { issues: ['kind'] },
    });
    assert({
      given: 'a later entity version naming a known kind',
      should:
        'accept it: entityVersion is the entity version, not a fixed schema literal',
      actual: parseOutcome(outboxPayloadSchema, {
        entityVersion: 7,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: {
        data: {
          entityVersion: 7,
          kind: 'room.changed',
          ids: [id],
        },
      },
    });
  });

  test('names the entity version entityVersion, never version', () => {
    assert({
      given: 'a doorbell payload carrying its entity version as version',
      should: 'reject it: version names a schema version elsewhere',
      actual: parseOutcome(outboxPayloadSchema, {
        version: 1,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: { issues: ['entityVersion', '(root)'] },
    });
  });

  test('rejects an entity version that is not a positive integer', () => {
    assert({
      given: 'zero, a negative integer, and a fractional version',
      should: 'reject all three: the entity version is a positive integer',
      actual: [
        parseOutcome(outboxPayloadSchema, {
          entityVersion: 0,
          kind: 'room.changed',
          ids: [id],
        }),
        parseOutcome(outboxPayloadSchema, {
          entityVersion: -1,
          kind: 'room.changed',
          ids: [id],
        }),
        parseOutcome(outboxPayloadSchema, {
          entityVersion: 1.5,
          kind: 'room.changed',
          ids: [id],
        }),
      ],
      expected: [
        { issues: ['entityVersion'] },
        { issues: ['entityVersion'] },
        { issues: ['entityVersion'] },
      ],
    });
  });

  test('rejects a doorbell payload carrying anything beyond ids, kind and version', () => {
    assert({
      given: 'a doorbell-shaped payload with an extra field',
      should: 'reject it',
      actual: parseOutcome(outboxPayloadSchema, {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [id],
        phase: 'active',
      }),
      expected: { issues: ['(root)'] },
    });
  });

  test('lets the owner-only inbox family carry a small delta beyond ids, kind and version', () => {
    assert({
      given: 'a notification delta payload for the owner-only inbox family',
      should: 'accept it',
      actual: parseOutcome(outboxPayloadSchema, {
        entityVersion: 1,
        kind: 'user.notification-delivered',
        ids: [id],
        notificationType: 'room.invited',
        occurredAt: '2026-01-01T00:00:00.000Z',
      }),
      expected: {
        data: {
          entityVersion: 1,
          kind: 'user.notification-delivered',
          ids: [id],
          notificationType: 'room.invited',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });
  });

  test('accepts the two revocation kinds so the drain never meets an unparseable row', () => {
    assert({
      given: 'session.revoked and access.revoked payloads',
      should: 'both accept',
      actual: [
        parseOutcome(outboxPayloadSchema, {
          entityVersion: 1,
          kind: 'session.revoked',
          ids: [id],
        }),
        parseOutcome(outboxPayloadSchema, {
          entityVersion: 1,
          kind: 'access.revoked',
          ids: [id, otherId],
        }),
      ],
      expected: [
        { data: { entityVersion: 1, kind: 'session.revoked', ids: [id] } },
        {
          data: {
            entityVersion: 1,
            kind: 'access.revoked',
            ids: [id, otherId],
          },
        },
      ],
    });
  });

  test('access.revoked requires exactly [userId, roomId], never a single id', () => {
    assert({
      given: 'an access.revoked payload with only one id',
      should: 'reject it: the user and the room topic are both required',
      actual: parseOutcome(outboxPayloadSchema, {
        entityVersion: 1,
        kind: 'access.revoked',
        ids: [id],
      }),
      expected: { issues: ['ids'] },
    });
  });
});

describe('payload-to-topic-family storage binding', () => {
  test('accepts a payload whose kind belongs to the topic family', () => {
    assert({
      given: "a room.changed doorbell on the room's own topic",
      should: 'be allowed',
      actual: isPayloadStorableOnTopic(`room:${id}`, {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: true,
    });
  });

  test('rejects an owner-only inbox delta stored on a public room topic', () => {
    assert({
      given: 'a user.notification-delivered payload on a room topic',
      should: 'be refused: only room.changed belongs to that family',
      actual: isPayloadStorableOnTopic(`room:${id}`, {
        entityVersion: 1,
        kind: 'user.notification-delivered',
        ids: [id],
        notificationType: 'room.invited',
        occurredAt: '2026-01-01T00:00:00.000Z',
      }),
      expected: false,
    });
  });

  test('rejects any payload on a room:presence topic, since presence is delivered as a direct doorbell, not the outbox', () => {
    assert({
      given:
        'a room.changed doorbell on a room:presence topic (presence is never in the outbox)',
      should: 'be refused: room:presence allows no outbox kind',
      actual: isPayloadStorableOnTopic(`room:${id}:presence`, {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: false,
    });
  });

  test('rejects any payload on a chat topic, since chat delivery is not built yet', () => {
    assert({
      given: 'a room.changed doorbell on the (unbuilt) chat topic',
      should: 'be refused: room:chat allows no kind yet',
      actual: isPayloadStorableOnTopic(`room:${id}:chat`, {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: false,
    });
  });
});
