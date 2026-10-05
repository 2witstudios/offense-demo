import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import { appendOutboxEvent } from './outbox';

type Tx = Pick<BunSQLDatabase, 'execute' | 'insert'>;

/**
 * The one `session.revoked` outbox append (ISSUE-8 AC2), run inside the
 * caller's transaction: one row on the revoked user's own inbox topic
 * (`user:<userId>:inbox`), naming that user. Shared by every revocation
 * path (`appendSessionRevoked`, `revokeOtherSessions`) so the event shape
 * lives in one place.
 */
export async function appendSessionRevokedFor(
  tx: Tx,
  userId: string,
): Promise<void> {
  await appendOutboxEvent(tx, {
    topic: buildUserInboxTopic(userId),
    kind: 'session.revoked',
    version: 1,
    payload: { entityVersion: 1, kind: 'session.revoked', ids: [userId] },
  });
}
