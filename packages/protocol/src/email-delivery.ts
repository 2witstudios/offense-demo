/**
 * The one email delivery status vocabulary (ADR 0025), in rank order: a
 * status's rank is its position, so a late provider event can never lower a
 * message's state. The webhook classifier ranks with it and the
 * `email_delivery_status_check` CHECK pins each status to the same rank, so
 * the two can never disagree.
 */
export const emailDeliveryStatuses = [
  'sent',
  'delayed',
  'delivered',
  'failed',
  'bounced',
  'complained',
] as const;
export type EmailDeliveryStatus = (typeof emailDeliveryStatuses)[number];

/** A status's monotonic rank: its 1-based position in the vocabulary. */
export const emailDeliveryStatusRank = (status: EmailDeliveryStatus): number =>
  emailDeliveryStatuses.indexOf(status) + 1;

/** Why a recipient stops receiving automatic mail: hard bounces and complaints. */
export const emailSuppressionReasons = ['bounce', 'complaint'] as const;
export type EmailSuppressionReason = (typeof emailSuppressionReasons)[number];
