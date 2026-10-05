import { recipientKey } from './recipient-key';
import { unavailable } from './public-errors';
import {
  undeliverable,
  type UndeliverableRefusal,
} from './deliver-or-unavailable';
import type { AuthDeliveryLedger } from './mail-types';

/** The public answers a refusal carries, worded for the flow asking. */
export type SuppressionRefusals = {
  /** The ledger could not be read: a retryable 503, never an allow. */
  readonly unavailable: string;
  /** A prior hard bounce or complaint: a 422 with this code and sentence. */
  readonly undeliverable: UndeliverableRefusal;
};

/**
 * Refuses an address the suppression ledger holds (ADR 0025) before any
 * token is created or mail sent: the one request-time check behind the
 * sign-in gate and both addresses of an email change (ISSUE-104,
 * ISSUE-113).
 */
export const createSuppressionCheck =
  (dependencies: {
    readonly recipientSubkey: string;
    readonly ledger: AuthDeliveryLedger;
  }) =>
  async (email: string, refusals: SuppressionRefusals): Promise<void> => {
    let suppressed: boolean;
    try {
      suppressed = await dependencies.ledger.isSuppressed(
        recipientKey(dependencies.recipientSubkey, email),
      );
    } catch {
      throw unavailable('AUTH_TEMPORARILY_UNAVAILABLE', refusals.unavailable);
    }
    if (suppressed) throw undeliverable(refusals.undeliverable);
  };

export type SuppressionCheck = ReturnType<typeof createSuppressionCheck>;
