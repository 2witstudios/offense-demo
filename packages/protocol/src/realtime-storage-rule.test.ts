import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { isPayloadStorableOnTopic } from './realtime-payloads';
import { buildUserInboxTopic } from './topics';

setupRitewayBun();

const id = 'k2v9x0f4m8q3w1z7c5n6b4d2';
const otherId = 'm8q3w1z7c5n6b4d2k2v9x0f4';

describe('storage family rule', () => {
  const inbox = buildUserInboxTopic(id);

  test('accepts the three control kinds as storable on the inbox family', () => {
    assert({
      given:
        'session.revoked, access.revoked and user.presence-preference-changed on user:inbox',
      should: 'each be storable',
      actual: [
        isPayloadStorableOnTopic(inbox, {
          entityVersion: 1,
          kind: 'session.revoked',
          ids: [id],
        }),
        isPayloadStorableOnTopic(inbox, {
          entityVersion: 1,
          kind: 'access.revoked',
          ids: [id, otherId],
        }),
        isPayloadStorableOnTopic(inbox, {
          entityVersion: 1,
          kind: 'user.presence-preference-changed',
          ids: [id],
        }),
      ],
      expected: [true, true, true],
    });
  });

  test('still stores the ordinary inbox delta kind alongside the control kinds', () => {
    assert({
      given: 'a user.notification-delivered delta on user:inbox',
      should: 'be storable, as it always was',
      actual: isPayloadStorableOnTopic(inbox, {
        entityVersion: 1,
        kind: 'user.notification-delivered',
        ids: [id],
        notificationType: 'room.invited',
        occurredAt: '2026-01-01T00:00:00.000Z',
      }),
      expected: true,
    });
  });

  test('refuses the doorbell kind as storable on the inbox: the widening is control kinds only', () => {
    assert({
      given:
        'room.changed tested against isPayloadStorableOnTopic on user:inbox',
      should:
        'be refused: storageFamilyPayloadKinds widens user:inbox by the three control kinds, not by every kind',
      actual: isPayloadStorableOnTopic(inbox, {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [id],
      }),
      expected: false,
    });
  });

  test('refuses each control kind as storable on every family the rule does not widen', () => {
    const nonInboxTopics = [
      `room:${id}`,
      `room:${id}:presence`,
      `room:${id}:chat`,
    ];
    const controlKindPayloads = [
      { entityVersion: 1, kind: 'session.revoked', ids: [id] },
      { entityVersion: 1, kind: 'access.revoked', ids: [id, otherId] },
      {
        entityVersion: 1,
        kind: 'user.presence-preference-changed',
        ids: [id],
      },
    ];
    assert({
      given:
        'each of the three control kinds tested against room, room:presence and room:chat',
      should:
        'be refused on every one: only user:inbox is widened to accept control kinds',
      actual: nonInboxTopics.flatMap((topic) =>
        controlKindPayloads.map((payload) =>
          isPayloadStorableOnTopic(topic, payload),
        ),
      ),
      expected: nonInboxTopics.flatMap(() =>
        controlKindPayloads.map(() => false),
      ),
    });
  });

  test('still refuses every other family the storage-side rule does not widen', () => {
    assert({
      given:
        'a room.changed doorbell tested against both rules on its own topic',
      should: 'agree: storage and delivery are identical outside user:inbox',
      actual: [
        isPayloadStorableOnTopic(`room:${id}`, {
          entityVersion: 1,
          kind: 'room.changed',
          ids: [id],
        }),
        isPayloadStorableOnTopic(`room:${id}:presence`, {
          entityVersion: 1,
          kind: 'room.changed',
          ids: [id],
        }),
      ],
      expected: [true, false],
    });
  });
});
