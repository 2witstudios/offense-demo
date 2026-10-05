import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import type {
  EmailDeliveryStatus,
  EmailSuppressionReason,
} from '@offense-demo/protocol';
import { createDatabase } from '../src';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

const at = '2026-09-20T00:00:00.000Z';
const cleanup = async (messageIds: string[], hashes: string[]) => {
  const sql = new SQL(url);
  try {
    for (const id of messageIds) {
      await sql`DELETE FROM email_delivery_event WHERE provider_message_id=${id}`;
      await sql`DELETE FROM email_delivery WHERE provider_message_id=${id}`;
    }
    for (const hash of hashes)
      await sql`DELETE FROM email_suppression WHERE recipient_hash=${hash}`;
  } finally {
    await sql.close();
  }
};

test('delivery events dedupe, never lower status, and suppress only after hard failure', async () => {
  const messageId = `msg-${createId()}`;
  const hash = `hash-${createId()}`;
  const database = createDatabase({ url });
  try {
    await database.recordEmailDelivery({
      providerMessageId: messageId,
      recipientHash: hash,
      at,
    });
    // Retrying the same provider message (same idempotency key) is a no-op.
    await database.recordEmailDelivery({
      providerMessageId: messageId,
      recipientHash: hash,
      at,
    });
    const suppressedBefore = await database.isRecipientSuppressed(hash);

    const event = (
      eventId: string,
      status: EmailDeliveryStatus,
      rank: number,
      suppress: EmailSuppressionReason | null = null,
    ) =>
      database.applyEmailDeliveryEvent({
        eventId,
        providerMessageId: messageId,
        status,
        rank,
        suppress,
        at,
      });
    const bounced = `evt-${createId()}`;
    // Out of order: the terminal bounce arrives before "delivered".
    const outOfOrder = [
      await event(bounced, 'bounced', 5, 'bounce'),
      await event(`evt-${createId()}`, 'delivered', 3),
    ];
    // Concurrent redelivery of one event ID applies exactly once.
    const duplicate = `evt-${createId()}`;
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => event(duplicate, 'delayed', 2)),
    );
    const redelivered = await event(bounced, 'bounced', 5, 'bounce');
    const probe = new SQL(url);
    const [stored] =
      await probe`SELECT status, status_rank FROM email_delivery WHERE provider_message_id=${messageId}`.finally(
        () => probe.close(),
      );
    assert({
      given:
        'a recorded send, an early bounce, a late delivered, eight concurrent copies of one event and a redelivered bounce',
      should:
        'apply each event ID once, keep the highest status, and suppress only after the bounce',
      actual: {
        suppressedBefore,
        outOfOrder,
        concurrent: [...concurrent].sort(),
        redelivered,
        stored,
        suppressedAfter: await database.isRecipientSuppressed(hash),
      },
      expected: {
        suppressedBefore: false,
        outOfOrder: ['applied', 'applied'],
        concurrent: ['applied', ...Array(7).fill('duplicate')],
        redelivered: 'duplicate',
        stored: { status: 'bounced', status_rank: 5 },
        suppressedAfter: true,
      },
    });
  } finally {
    await database.close();
    await cleanup([messageId], [hash]);
  }
});

test('an event for an unrecorded message is retryable and leaves no dedupe row', async () => {
  const database = createDatabase({ url });
  const eventId = `evt-${createId()}`;
  const messageId = `msg-${createId()}`;
  const apply = () =>
    database.applyEmailDeliveryEvent({
      eventId,
      providerMessageId: messageId,
      status: 'delivered',
      rank: 3,
      suppress: null,
      at,
    });
  try {
    const beforeSend = await apply();
    await database.recordEmailDelivery({
      providerMessageId: messageId,
      recipientHash: `hash-${createId()}`,
      at,
    });
    // The provider retries the same event ID after the send is recorded.
    assert({
      given: 'an event before its send is recorded, retried after',
      should: 'answer unknown-message first, leaving no dedupe row, then apply',
      actual: [beforeSend, await apply()],
      expected: ['unknown-message', 'applied'],
    });
  } finally {
    await database.close();
    await cleanup([messageId], []);
  }
});
