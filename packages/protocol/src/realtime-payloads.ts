import { z } from 'zod';
import { idSchema } from './primitives';
import { parseTopic, type TopicFamily } from './topics';

// --- Outbox payloads ---------------------------------------------------

/**
 * `entityVersion` is the version of the entity the row announces (ADR 0032
 * §1), never a schema version: schema versions are `version` or `v`
 * elsewhere in the protocol, so the name alone says which it is. It only
 * ever increases, so it is a positive integer, never the literal `1`.
 */
const entityVersionSchema = z.int().positive();

/**
 * `room.presence-changed` is not one of these: presence is never written
 * to the outbox. It lives in Redis and is delivered as the
 * `presence.changed` server message instead, which carries no outbox
 * position or kind. Add a doorbell kind here for each new public entity
 * family a product announces.
 */
const doorbellKinds = ['room.changed'] as const;
const doorbellKindSchema = z.enum(doorbellKinds);

/** The doorbell shape: nothing beyond ids, kind and entity version. */
const doorbellPayloadSchema = z.strictObject({
  entityVersion: entityVersionSchema,
  kind: doorbellKindSchema,
  ids: z.array(idSchema).min(1).max(8),
});

/**
 * Only the owner-only `user:inbox` family may carry a small delta beyond
 * the doorbell fields (ADR 0032 §6). Notification content itself is a
 * product concern; this is the envelope shape it fills in.
 */
const inboxDeltaPayloadSchema = z.strictObject({
  entityVersion: entityVersionSchema,
  kind: z.literal('user.notification-delivered'),
  ids: z.array(idSchema).min(1).max(1),
  notificationType: z.string().trim().min(1).max(64),
  occurredAt: z.iso.datetime(),
});

/**
 * Revocations are outbox rows too (ADR 0032 §5), so every instance applies
 * them durably. They ride the user's own `user:<userId>:inbox` topic as
 * control rows (ADR 0032 §6): storable there, but never
 * delivered as an `event` message. `session.revoked` closes the matching
 * sockets directly, and `access.revoked` unsubscribes the user from the
 * topic named in `ids`; realtime consumes both straight from the drain.
 */
const sessionRevokedPayloadSchema = z.strictObject({
  entityVersion: entityVersionSchema,
  kind: z.literal('session.revoked'),
  /** `[userId]` or `[userId, sessionId]`. */
  ids: z.array(idSchema).min(1).max(2),
});
const accessRevokedPayloadSchema = z.strictObject({
  entityVersion: entityVersionSchema,
  kind: z.literal('access.revoked'),
  /** Always exactly `[userId, roomId]`: the user to unsubscribe and the room topic. */
  ids: z.array(idSchema).length(2),
});

/**
 * A presence-visibility preference change: appended in the settings
 * transaction on the user's own inbox as a control row. Realtime consumes
 * it to re-project that user's presence locally and ring
 * `presence.changed`; presence state itself is still never written to the
 * outbox. It never rides a subscribed topic as an `event`, exactly like the
 * two revocation kinds above.
 */
const userPresencePreferenceChangedPayloadSchema = z.strictObject({
  entityVersion: entityVersionSchema,
  kind: z.literal('user.presence-preference-changed'),
  /** `[userId]`. */
  ids: z.array(idSchema).length(1),
});

/** The outbox payload contract, discriminated by `kind`, always carrying `entityVersion`. */
export const outboxPayloadSchema = z.discriminatedUnion('kind', [
  doorbellPayloadSchema,
  inboxDeltaPayloadSchema,
  sessionRevokedPayloadSchema,
  accessRevokedPayloadSchema,
  userPresencePreferenceChangedPayloadSchema,
]);
type OutboxPayload = z.infer<typeof outboxPayloadSchema>;
type OutboxPayloadKind = OutboxPayload['kind'];

/**
 * Which kinds an outbox row may carry on each topic family. Public families
 * (`room`) carry only their own doorbell. `room:presence`
 * and `room:chat` carry nothing: presence is never written to the outbox
 * and chat delivery is not built yet. The owner-only `user:inbox` carries
 * its delta plus the three control kinds realtime consumes from the drain
 * and never forwards to a client. `@offense-demo/db`'s append validates each row
 * against this rule.
 */
const storageFamilyPayloadKinds: Readonly<
  Record<TopicFamily, readonly OutboxPayloadKind[]>
> = {
  room: ['room.changed'],
  'room:presence': [],
  'room:chat': [],
  'user:inbox': [
    'user.notification-delivered',
    'session.revoked',
    'access.revoked',
    'user.presence-preference-changed',
  ],
};

/**
 * Validates an outbox payload against both its own shape and the topic it
 * would be stored on: the payload must parse, and its `kind` must be one
 * this topic's family may carry. `@offense-demo/db`'s append calls this before
 * insert.
 */
export function isPayloadStorableOnTopic(
  topic: string,
  payload: unknown,
): boolean {
  const parsedTopic = parseTopic(topic);
  if (!parsedTopic) return false;
  const parsedPayload = outboxPayloadSchema.safeParse(payload);
  if (!parsedPayload.success) return false;
  return storageFamilyPayloadKinds[parsedTopic.family].includes(
    parsedPayload.data.kind,
  );
}
