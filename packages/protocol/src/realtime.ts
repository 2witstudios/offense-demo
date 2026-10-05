import { z } from 'zod';
import { idSchema } from './primitives';
import { topicStringSchema } from './topics';

/**
 * Nominal branding (a phantom marker, erased at runtime) so
 * `ENVELOPE_VERSION` and `PROTOCOL_VERSION` cannot be validated against each
 * other by a future edit: assigning one where the other is expected, or
 * defining one in terms of the other, is a type error caught by
 * `bun typecheck`, even though both equal `1` today. A plain shared `number`
 * literal cannot make that distinction, since the values coincide.
 */
type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };
export type EnvelopeVersion = Brand<number, 'EnvelopeVersion'>;
export type ProtocolVersion = Brand<number, 'ProtocolVersion'>;

/**
 * The message-envelope version, stamped on `v` in every client and server
 * message. It versions the wire framing (the envelope shape itself), not
 * the message set `hello` negotiates (ADR 0031 §6): the two are distinct
 * values that happen to both start at `1`, tracked by separate branded
 * constants so one can change without forcing the other. An unsupported `v`
 * closes the socket with `protocol_unsupported` rather than being silently
 * dropped, unlike PageSpace's socket.io events.
 */
export const ENVELOPE_VERSION: EnvelopeVersion = 1 as EnvelopeVersion;

/**
 * The application protocol version `hello.protocolVersion` negotiates: the
 * client and server message set and semantics. See `ENVELOPE_VERSION` for
 * why this is a separate branded constant rather than the same literal
 * reused.
 */
export const PROTOCOL_VERSION: ProtocolVersion = 1 as ProtocolVersion;

/**
 * The application heartbeat period (ADR 0031 §7): the client sends `ping`
 * every 15 s and measures misses by elapsed time since the last `pong`, dead
 * after two periods without one. Shared here so the client and any server
 * grace window derived from it read one value instead of each hard-coding
 * `15000`.
 */
export const heartbeatMs = 15_000;

/**
 * Typed literal builders: each accepts only its own branded version type, so
 * `PROTOCOL_VERSION` declared as `= ENVELOPE_VERSION` is a type error caught
 * by `bun typecheck`, not merely a coincidence that both constants are `1`.
 * They do not by themselves stop a mutation that hard-codes a literal
 * `z.literal(ENVELOPE_VERSION)` into the `hello` schema's `protocolVersion`
 * field, or `z.literal(PROTOCOL_VERSION)` into `buildEnvelope`'s `v` field:
 * those mutations bypass these builders entirely, so it is
 * `buildHelloMessageSchema` and `buildClientMessageSchema` below, each
 * tested with distinct injected versions, that catch them.
 */
function envelopeVersionLiteral(
  version: EnvelopeVersion,
): z.ZodLiteral<EnvelopeVersion> {
  return z.literal(version);
}
function protocolVersionLiteral(
  version: ProtocolVersion,
): z.ZodLiteral<ProtocolVersion> {
  return z.literal(version);
}

/** The envelope shape `{v}`, built from an injected envelope version. */
function buildEnvelope(envelopeVersion: EnvelopeVersion): {
  readonly v: z.ZodLiteral<EnvelopeVersion>;
} {
  return { v: envelopeVersionLiteral(envelopeVersion) } as const;
}

/**
 * The `hello` message schema, built from independently injected envelope and
 * protocol versions. Production wires it with the two real
 * constants below; `realtime-messages.test.ts` wires it with two distinct
 * values so a mutation that hard-codes either field to the other's version,
 * or to a module-level constant instead of its own parameter, turns the
 * composed schema — not just the isolated literal builders — red.
 */
export function buildHelloMessageSchema(
  envelopeVersion: EnvelopeVersion,
  protocolVersion: ProtocolVersion,
) {
  return z.strictObject({
    ...buildEnvelope(envelopeVersion),
    type: z.literal('hello'),
    protocolVersion: protocolVersionLiteral(protocolVersion),
    ticket: ticketSchema,
  });
}

/**
 * An opaque `(txid, seq)` outbox position, serialized as `txid:seq`
 * (see the plan's cursor-correctness section). It is an ordering token, not
 * a secret, but its shape is still validated on every use. Each part is
 * bounded to 1-20 digits: `txid` is `xid8` (PostgreSQL's 64-bit transaction
 * id) and `seq` is `bigserial` (a signed 64-bit sequence); 20 digits covers
 * `xid8`'s full unsigned range, with no leading zero except the value `0`
 * itself.
 */
export const cursorSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,19}):(0|[1-9]\d{0,19})$/);

/**
 * A single-use realtime connect ticket (ADR 0031 §11): 32 CSPRNG bytes,
 * base64url-encoded, so exactly 43 characters and never padded. It is a
 * bearer secret, so it is never a cuid2 and is never logged.
 */
export const ticketSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// --- Client message envelopes -----------------------------------------

export const presenceActivitySchema = z.enum(['active', 'idle']);
export type PresenceActivity = z.infer<typeof presenceActivitySchema>;
/**
 * The one projected presence status vocabulary: what a
 * `room:<id>:presence` topic's projected value reports for each user,
 * and what the UI's presence dot renders.
 */
export const presenceStatuses = [
  'in-room',
  'online',
  'away',
  'offline',
] as const;
export type PresenceStatus = (typeof presenceStatuses)[number];

/**
 * The socket accepts exactly these five inbound types (ADR 0031 §4).
 * Commands go over HTTP to `apps/web`; adding a command message here would
 * reopen the attack surface the plan deliberately closed. `id` is present
 * only on messages that expect a reply keyed by that same `id`: `subscribe`,
 * `unsubscribe` and `ping`.
 *
 * Built from an independently injected envelope version: every non-`hello` member spreads the same `buildEnvelope`
 * result `hello` is built from, so a mutation that hard-codes any of these
 * `v` fields to `PROTOCOL_VERSION` instead of the injected
 * `envelopeVersion` turns the composed schema red under a distinct injected
 * value, exactly like `buildHelloMessageSchema` catches the mirror mutation
 * on `hello` itself.
 */
export function buildClientMessageSchema(
  envelopeVersion: EnvelopeVersion,
  protocolVersion: ProtocolVersion,
) {
  const envelope = buildEnvelope(envelopeVersion);
  return z.discriminatedUnion('type', [
    buildHelloMessageSchema(envelopeVersion, protocolVersion),
    z.strictObject({
      ...envelope,
      type: z.literal('subscribe'),
      id: idSchema,
      topic: topicStringSchema,
      since: cursorSchema.optional(),
    }),
    z.strictObject({
      ...envelope,
      type: z.literal('unsubscribe'),
      id: idSchema,
      topic: topicStringSchema,
    }),
    z.strictObject({
      ...envelope,
      type: z.literal('presence.activity'),
      activity: presenceActivitySchema,
    }),
    z.strictObject({
      ...envelope,
      type: z.literal('ping'),
      id: idSchema,
    }),
  ]);
}

export const clientMessageSchema = buildClientMessageSchema(
  ENVELOPE_VERSION,
  PROTOCOL_VERSION,
);
