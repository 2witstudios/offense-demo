import { z } from 'zod';
import { idSchema } from './primitives';

/**
 * The one topic-family vocabulary: the four families realtime delivers on.
 * A family is a topic's first segment, plus its third when it has one
 * (`room:<id>:presence` is `room:presence`). Every other string is
 * refused by `parseTopic` at the trust boundary. The outbox storage rule
 * (realtime-payloads.ts) is keyed by it.
 */
const topicFamilies = [
  'room',
  'room:presence',
  'room:chat',
  'user:inbox',
] as const;
const topicFamilySchema = z.enum(topicFamilies);
export type TopicFamily = z.infer<typeof topicFamilySchema>;

type ParsedTopic =
  | {
      readonly family: Exclude<TopicFamily, 'user:inbox'>;
      readonly roomId: string;
    }
  | { readonly family: 'user:inbox'; readonly userId: string };

/** `<head>:<key>` or `<head>:<key>:<suffix>` names the family `<head>[:<suffix>]`. */
function familyOf(segments: readonly string[]): string | undefined {
  if (segments.length === 2) return segments[0];
  if (segments.length === 3) return `${segments[0]}:${segments[2]}`;
  return undefined;
}

/**
 * Parses a topic string into its family and ids, validating every id
 * segment against cuid2. Returns `undefined`
 * for anything that is not one of the four known shapes exactly, including
 * extra segments or a missing/malformed id — parsing never normalizes or
 * repairs input (ADR 0023).
 */
export function parseTopic(topic: string): ParsedTopic | undefined {
  const segments = topic.split(':');
  const family = topicFamilySchema.safeParse(familyOf(segments));
  if (!family.success) return undefined;
  const key = segments[1]!;
  if (!idSchema.safeParse(key).success) return undefined;
  return family.data === 'user:inbox'
    ? { family: 'user:inbox', userId: key }
    : { family: family.data, roomId: key };
}

/**
 * A topic string, validated through the shared parser, for message schemas.
 * Bounded well above the longest real topic (`room:<id>:presence` is
 * 38 characters) but far under the frame cap (ADR 0031 §6's
 * `maxPayloadLength: 4096`), so an oversized topic is rejected here rather
 * than by the transport.
 */
export const topicStringSchema = z
  .string()
  // A parse-cost guard, not a grammar limit: no valid topic comes near 128,
  // so there is no accept edge to test. It aborts, so an oversized string
  // never reaches parseTopic's grammar.
  .max(128, { abort: true })
  .refine((value) => parseTopic(value) !== undefined, {
    message: 'Not a valid realtime topic',
  });

/**
 * The only way a topic string is built: the id segment is validated and a
 * malformed one throws, so a bad topic is never constructed. Builders for
 * the other families are added with their first consumer.
 */
export const buildUserInboxTopic = (userId: string): string =>
  `user:${idSchema.parse(userId)}:inbox`;

/** The `room:<id>` family. */
export const buildRoomTopic = (roomId: string): string =>
  `room:${idSchema.parse(roomId)}`;
