/**
 * The documented close-code taxonomy (ADR 0031 §8): a small, fixed set in
 * the application range (4000-4999), each with the client reaction the ADR
 * specifies. This table is the single authority the socket and its clients
 * code against — @offense-demo/protocol conforms to it, not the reverse.
 *
 * Its own module: close codes are a transport-level concern (what closes the
 * socket), not an outbox-payload concern, so they do not belong next to
 * `doorbellPayloadSchema` and friends in realtime-payloads.ts.
 */
export const closeCodeTable = [
  {
    code: 4001,
    reason: 'auth_failed',
    description:
      'no hello within 5s; a bad, expired, replayed or origin-mismatched ticket; or any message before hello. Client: fetch a fresh ticket and reconnect with backoff; after 3 consecutive failures, stop and show signed-out state.',
  },
  {
    code: 4002,
    reason: 'revoked',
    description:
      'session.revoked, or the 60s revalidation finds the session gone. Client: do not reconnect; refetch the session over HTTP.',
  },
  {
    code: 4003,
    reason: 'protocol_unsupported',
    description:
      'hello.protocolVersion unsupported, or an inbound message fails to parse. Client: do not reconnect; ask the user to reload.',
  },
  {
    code: 4004,
    reason: 'rate_limited',
    description:
      'connection or inbound-message rate limit exceeded. Client: reconnect with jittered backoff from a 30s floor.',
  },
  {
    code: 4005,
    reason: 'slow_consumer',
    description:
      "the socket's send buffer passed the soft bound. Client: reconnect with jitter and resubscribe from cursors.",
  },
  {
    code: 4006,
    reason: 'server_restarting',
    description:
      'SIGTERM drain. Client: reconnect with 0-5s jitter (another instance takes it).',
  },
] as const;
export type CloseCodeReason = (typeof closeCodeTable)[number]['reason'];
