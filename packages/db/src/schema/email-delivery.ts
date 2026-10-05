import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  smallint,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import {
  emailDeliveryStatuses,
  emailDeliveryStatusRank,
  emailSuppressionReasons,
} from '@offense-demo/protocol';
import {
  createdAtColumn,
  oneOf,
  timestampColumn,
  updatedAtColumn,
} from './columns';

/**
 * Each protocol delivery status paired with its monotonic rank (ADR 0025):
 * the CHECK pins a status to its one rank, so the pair can never disagree
 * and a late provider event can never lower a message's state.
 */
const statusRankPairs = sql.raw(
  emailDeliveryStatuses
    .map((status) => `('${status}', ${emailDeliveryStatusRank(status)})`)
    .join(', '),
);

/**
 * Diagnostic mail state. Recipients appear only as a keyed hash and provider
 * webhook payloads are never stored: only message/event IDs and safe status.
 * Retention: the retention sweep deletes a row 30 days after its last
 * status change (`apps/web/src/server/retention-sweep.ts`).
 */
export const emailDeliveries = pgTable(
  'email_delivery',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    providerMessageId: text('provider_message_id').notNull(),
    recipientHash: text('recipient_hash').notNull(),
    status: text('status').notNull(),
    /** Monotonic: an out-of-order event can never lower it. */
    statusRank: smallint('status_rank').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('email_delivery_provider_message_unique').on(
      table.providerMessageId,
    ),
    index('email_delivery_recipient_idx').on(table.recipientHash),
    /** The retention sweep prunes by last status change, oldest first. */
    index('email_delivery_updated_at_idx').on(table.updatedAt),
    check(
      'email_delivery_status_check',
      sql`(${table.status}, ${table.statusRank}) in (${statusRankPairs})`,
    ),
  ],
);

/**
 * Webhook event dedupe, keyed by the provider's event ID. Retention: the
 * retention sweep deletes a row 30 days after it was received.
 */
export const emailDeliveryEvents = pgTable(
  'email_delivery_event',
  {
    providerEventId: text('provider_event_id').primaryKey(),
    providerMessageId: text('provider_message_id').notNull(),
    receivedAt: timestampColumn('received_at').notNull().defaultNow(),
  },
  (table) => [
    index('email_delivery_event_received_idx').on(table.receivedAt),
    index('email_delivery_event_provider_message_idx').on(
      table.providerMessageId,
    ),
  ],
);

/**
 * Hard bounces and complaints stop automatic resend loops. Never pruned by
 * the retention sweep: a suppression must outlive its delivery row, and it
 * holds only the keyed recipient hash.
 */
export const emailSuppressions = pgTable(
  'email_suppression',
  {
    recipientHash: text('recipient_hash').primaryKey(),
    reason: text('reason').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    check(
      'email_suppression_reason_check',
      oneOf(table.reason, emailSuppressionReasons),
    ),
  ],
);
