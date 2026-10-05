import { createHmac } from 'node:crypto';
import { afterAll } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { createTestApp, webhookSecret, withSql } from './fixtures';
import { deriveRecipientSubkey } from '../src/features/auth/recipient-key';

const sign = (id: string, timestamp: string, body: string) =>
  `v1,${createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64')}`;

/** A provider delivery exactly as Resend would sign it (payload holds the recipient). */
export const providerEvent = (
  type: string,
  messageId: string,
  options: {
    eventId?: string;
    recipient?: string;
    bounceType?: string;
    createdAt?: string;
  } = {},
) => {
  const body = JSON.stringify({
    type,
    created_at: options.createdAt ?? new Date().toISOString(),
    data: {
      email_id: messageId,
      to: [options.recipient ?? 'recipient@example.test'],
      ...(options.bounceType ? { bounce: { type: options.bounceType } } : {}),
    },
  });
  const id = options.eventId ?? `evt_${createId()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request('http://localhost:3000/api/webhooks/resend', {
    method: 'POST',
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': sign(id, timestamp, body),
      'content-type': 'application/json',
    },
    body,
  });
};

export const deliveryRow = (messageId: string) =>
  withSql(
    (sql) =>
      sql`SELECT status, status_rank, recipient_hash FROM email_delivery WHERE provider_message_id = ${messageId}`,
  );

/**
 * One mounted-route suite (its own app) over real PostgreSQL/Redis with a
 * private mailbox.
 * Registers its own cleanup: only records this suite created are removed.
 */
export function createMailSuite() {
  const testApp = createTestApp();
  const { app, routes, mailbox, jsonPost, formPost, freshEmail } = testApp;
  const recipientSubkey = deriveRecipientSubkey(
    app.auth().config.RECIPIENT_HASH_SECRET,
  );
  // Ids of messages the suite makes up itself; the mailbox's own are
  // removed by createTestApp's teardown.
  const messageIds: string[] = [];
  const requestLink = async (email: string) => {
    const before = mailbox.mails.length;
    const response = await routes.auth.POST(
      jsonPost('/api/auth/sign-in/magic-link', { email }),
    );
    const mail = mailbox.mails[before];
    return { response, mail };
  };
  afterAll(async () => {
    await withSql(async (sql) => {
      for (const id of messageIds) {
        await sql`DELETE FROM email_delivery_event WHERE provider_message_id = ${id}`;
        await sql`DELETE FROM email_delivery WHERE provider_message_id = ${id}`;
      }
    });
  });
  return {
    app,
    mailbox,
    jsonPost,
    formPost,
    authRoute: routes.auth,
    confirmRoute: routes.confirm,
    webhookRoute: routes.mailWebhook,
    recipientSubkey,
    messageIds,
    fresh: freshEmail,
    requestLink,
  };
}
