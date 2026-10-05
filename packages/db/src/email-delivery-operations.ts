import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { and, eq, lt } from 'drizzle-orm';
import type {
  EmailDeliveryStatus,
  EmailSuppressionReason,
} from '@offense-demo/protocol';
import { verifications } from './schema/auth';
import {
  emailDeliveries,
  emailDeliveryEvents,
  emailSuppressions,
} from './schema/email-delivery';
import { instrumented, type DatabaseEventSink } from './instrumented';
import { deleteExpiredBatch, type RetentionBatch } from './retention';

/**
 * The email area (ISSUE-8 AC1, ADR 0025): delivery ledger, suppressions and
 * verification retention, composed into `createDatabase`.
 */
export const emailDeliveryOperations = ({
  database,
  eventSink,
}: {
  readonly database: BunSQLDatabase;
  readonly eventSink?: DatabaseEventSink | undefined;
}) => ({
  /**
   * Retention (AUTH-7.5a): one bounded batch of verification rows whose
   * expiry is before the cutoff, a predicate live rows can never satisfy.
   */
  async purgeExpiredVerifications(input: RetentionBatch) {
    return instrumented(eventSink, 'purgeExpiredVerifications', () =>
      deleteExpiredBatch(
        database,
        {
          table: verifications,
          key: verifications.id,
          at: verifications.expiresAt,
        },
        input,
      ),
    );
  },
  /**
   * Retention (ISSUE-8 AC5): one bounded batch of webhook dedupe rows
   * received before the cutoff. A provider retries an event for hours, not
   * weeks, so a pruned event ID is never replayed.
   */
  async purgeExpiredEmailDeliveryEvents(input: RetentionBatch) {
    return instrumented(eventSink, 'purgeExpiredEmailDeliveryEvents', () =>
      deleteExpiredBatch(
        database,
        {
          table: emailDeliveryEvents,
          key: emailDeliveryEvents.providerEventId,
          at: emailDeliveryEvents.receivedAt,
        },
        input,
      ),
    );
  },
  /**
   * Retention (ISSUE-8 AC5): one bounded batch of delivery diagnostics
   * whose last status change is before the cutoff. Suppressions live in
   * `email_suppression` and are never pruned here: a hard bounce or
   * complaint must keep stopping mail after its delivery row is gone.
   */
  async purgeExpiredEmailDeliveries(input: RetentionBatch) {
    return instrumented(eventSink, 'purgeExpiredEmailDeliveries', () =>
      deleteExpiredBatch(
        database,
        {
          table: emailDeliveries,
          key: emailDeliveries.id,
          at: emailDeliveries.updatedAt,
        },
        input,
      ),
    );
  },
  /** Idempotent: a retried send with the same provider message ID is a no-op. */
  async recordEmailDelivery(input: {
    providerMessageId: string;
    recipientHash: string;
    at: string;
  }) {
    return instrumented(eventSink, 'recordEmailDelivery', async () => {
      await database
        .insert(emailDeliveries)
        .values({
          providerMessageId: input.providerMessageId,
          recipientHash: input.recipientHash,
          status: 'sent',
          statusRank: 1,
          createdAt: new Date(input.at),
          updatedAt: new Date(input.at),
        })
        .onConflictDoNothing();
    });
  },
  async isRecipientSuppressed(recipientHash: string) {
    return instrumented(eventSink, 'isRecipientSuppressed', async () => {
      const [row] = await database
        .select({ recipientHash: emailSuppressions.recipientHash })
        .from(emailSuppressions)
        .where(eq(emailSuppressions.recipientHash, recipientHash))
        .limit(1);
      return row !== undefined;
    });
  },
  /**
   * One transaction: dedupe by provider event ID, raise (never lower) the
   * delivery rank, and record a suppression for hard failures. An event for
   * an unrecorded message rolls back its dedupe row so the provider's retry
   * is applied once the send is recorded.
   */
  async applyEmailDeliveryEvent(input: {
    eventId: string;
    providerMessageId: string;
    status: EmailDeliveryStatus;
    rank: number;
    suppress: EmailSuppressionReason | null;
    at: string;
  }): Promise<'applied' | 'duplicate' | 'unknown-message'> {
    const unknown = Symbol('unknown-message');
    return instrumented(eventSink, 'applyEmailDeliveryEvent', async () => {
      try {
        return await database.transaction(async (tx) => {
          const inserted = await tx
            .insert(emailDeliveryEvents)
            .values({
              providerEventId: input.eventId,
              providerMessageId: input.providerMessageId,
              receivedAt: new Date(input.at),
            })
            .onConflictDoNothing()
            .returning({ id: emailDeliveryEvents.providerEventId });
          if (inserted.length === 0) return 'duplicate' as const;
          const [delivery] = await tx
            .select({
              recipientHash: emailDeliveries.recipientHash,
            })
            .from(emailDeliveries)
            .where(
              eq(emailDeliveries.providerMessageId, input.providerMessageId),
            )
            .limit(1);
          if (!delivery) throw unknown;
          await tx
            .update(emailDeliveries)
            .set({
              status: input.status,
              statusRank: input.rank,
              updatedAt: new Date(input.at),
            })
            .where(
              and(
                eq(emailDeliveries.providerMessageId, input.providerMessageId),
                lt(emailDeliveries.statusRank, input.rank),
              ),
            );
          if (input.suppress)
            await tx
              .insert(emailSuppressions)
              .values({
                recipientHash: delivery.recipientHash,
                reason: input.suppress,
                providerMessageId: input.providerMessageId,
                createdAt: new Date(input.at),
              })
              .onConflictDoNothing();
          return 'applied' as const;
        });
      } catch (error) {
        if (error === unknown) return 'unknown-message' as const;
        throw error;
      }
    });
  },
});
