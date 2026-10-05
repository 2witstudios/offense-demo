import type { RedisTransport } from './transport';
import { idSchema } from '@offense-demo/protocol';
import { redisKey } from './redis-key';

/**
 * What a connect ticket is bound to (ADR 0031 §11): the signed-in user,
 * their session, and the origin the ticket was issued to.
 * Consumption checks all three; only the hex SHA3-256 hash of the plaintext
 * ticket is ever stored, never the ticket itself.
 */
export type TicketBinding = {
  readonly userId: string;
  readonly sessionId: string;
  readonly origin: string;
};

/** userId and sessionId are both cuid2 (session ids are minted the same way). */
function parseTicketBinding(value: unknown): TicketBinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const { userId, sessionId, origin } = value as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof origin !== 'string' ||
    origin.length === 0 ||
    !idSchema.safeParse(userId).success ||
    !idSchema.safeParse(sessionId).success
  )
    return null;
  return { userId, sessionId, origin };
}

function assertTicketBinding(binding: TicketBinding): void {
  if (!parseTicketBinding(binding)) throw new Error('Invalid ticket binding');
}

/** A hex SHA3-256 digest: 32 bytes, 64 lowercase hex characters. */
const ticketHashPattern = /^[0-9a-f]{64}$/;

function assertTicketHash(value: string): void {
  if (!ticketHashPattern.test(value)) throw new Error('Invalid ticket hash');
}

export type ConnectTicketResult =
  | {
      readonly accepted: true;
      readonly userId: string;
      readonly sessionId: string;
    }
  /**
   * `not-found` covers both an unknown hash and an expired one: Redis's TTL
   * already dropped the key, so there is nothing left to tell apart.
   */
  | {
      readonly accepted: false;
      readonly reason: 'not-found' | 'origin-mismatch' | 'malformed';
    };

export function createTicketOperations({
  client,
  namespace,
  reportFailure,
}: {
  readonly client: RedisTransport;
  readonly namespace: string;
  readonly reportFailure: (operation: string) => void;
}) {
  return {
    /** Stores only the ticket's hash, bound to its user, session and origin, with a mandatory TTL. */
    async issueConnectTicket(
      ticketHash: string,
      binding: TicketBinding,
      ttlSeconds: number,
    ): Promise<void> {
      assertTicketHash(ticketHash);
      assertTicketBinding(binding);
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
        throw new Error('TTL must be a positive integer');
      try {
        await client.connect();
        await client.send('SET', [
          redisKey(namespace, 'ticket', ticketHash),
          JSON.stringify(binding),
          'EX',
          String(ttlSeconds),
        ]);
      } catch (error) {
        reportFailure('issueConnectTicket');
        throw error;
      }
    },
    /**
     * Atomically reads and deletes the ticket by GETDEL, so a second call
     * with the same hash always finds nothing: single-use regardless of
     * whether this call accepts or rejects the binding. Rejects a binding
     * whose origin does not match `expectedOrigin`.
     */
    async consumeConnectTicket(
      ticketHash: string,
      expectedOrigin: string,
    ): Promise<ConnectTicketResult> {
      assertTicketHash(ticketHash);
      if (expectedOrigin.length === 0)
        throw new Error('Invalid expected origin');
      try {
        await client.connect();
        const raw = await client.getdel(
          redisKey(namespace, 'ticket', ticketHash),
        );
        if (raw === null) return { accepted: false, reason: 'not-found' };
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { accepted: false, reason: 'malformed' };
        }
        const binding = parseTicketBinding(parsed);
        if (!binding) return { accepted: false, reason: 'malformed' };
        if (binding.origin !== expectedOrigin)
          return { accepted: false, reason: 'origin-mismatch' };
        return {
          accepted: true,
          userId: binding.userId,
          sessionId: binding.sessionId,
        };
      } catch (error) {
        reportFailure('consumeConnectTicket');
        throw error;
      }
    },
  };
}
