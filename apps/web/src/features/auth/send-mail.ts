import { createAppError } from '@offense-demo/errors';
import type { Clock } from '@offense-demo/clock';
import type { Logger } from '@offense-demo/logger';
import type { Deliver } from './deliver-or-unavailable';
import type { AuthDeliveryLedger, AuthEmailSender } from './mail-types';
import { recipientKey } from './recipient-key';

/**
 * ISSUE-54: every auth mail, required or best-effort, goes through this
 * one path, and it honours suppression before anything reaches the
 * transport. A ledger outage is a failed send (callers fail closed or log),
 * never an implicit allow.
 */
export const createSendMail =
  (dependencies: {
    readonly recipientSubkey: string;
    readonly ledger: AuthDeliveryLedger;
    readonly emailSender: AuthEmailSender;
    readonly logger: Logger;
    readonly clock: Clock;
  }): Deliver =>
  async (message) => {
    const recipientHash = recipientKey(
      dependencies.recipientSubkey,
      message.to,
    );
    if (await dependencies.ledger.isSuppressed(recipientHash)) {
      dependencies.logger.log(
        'auth.mail.suppressed',
        { operation: 'auth.mail.send' },
        'Auth mail not sent: the recipient is suppressed',
      );
      return 'suppressed';
    }
    let receipt: Awaited<ReturnType<AuthEmailSender['send']>>;
    try {
      receipt = await dependencies.emailSender.send(message);
    } catch (error) {
      // Delivery failure is a generic retryable outcome: never surface
      // or log the provider exception, recipient or message body here.
      dependencies.logger.log(
        'auth.mail.failed',
        { operation: 'auth.mail.send', errorCode: 'INFRASTRUCTURE' },
        'Auth mail delivery failed',
      );
      throw createAppError('INFRASTRUCTURE', undefined, error);
    }
    if (receipt) {
      try {
        await dependencies.ledger.record({
          providerMessageId: receipt.providerMessageId,
          recipientHash,
          at: dependencies.clock.now(),
        });
      } catch {
        // The provider accepted the message, so the user has their email:
        // report success. The opaque provider id (no recipient data) keeps
        // the send reconcilable for bounce and complaint correlation.
        dependencies.logger.log(
          'auth.mail.receipt_failed',
          {
            operation: 'auth.mail.send',
            errorCode: 'INFRASTRUCTURE',
            providerMessageId: receipt.providerMessageId,
          },
          'Auth mail receipt was not recorded',
        );
      }
    }
    dependencies.logger.log(
      'auth.mail.sent',
      { operation: 'auth.mail.send' },
      'Auth mail delivered',
    );
    return 'sent';
  };
