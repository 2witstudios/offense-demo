import { APIError } from 'better-auth/api';
import { unavailable } from './public-errors';
import type { AuthEmailMessage } from './mail-types';
import {
  EMAIL_UNDELIVERABLE,
  type UndeliverableCode,
} from './undeliverable-codes';

/**
 * The one auth mail path (`send-mail.ts`): `suppressed`
 * when the recipient hard-bounced or complained, so nothing was sent
 * (ADR 0025, ISSUE-54).
 */
export type Deliver = (
  message: AuthEmailMessage,
) => Promise<'sent' | 'suppressed'>;

/** The public 422 a suppressed recipient answers: its code and sentence. */
export type UndeliverableRefusal = {
  readonly code: UndeliverableCode;
  readonly message: string;
};

export const undeliverable = ({ code, message }: UndeliverableRefusal) =>
  new APIError('UNPROCESSABLE_ENTITY', { code, message });

const SUPPRESSED_RECIPIENT: UndeliverableRefusal = {
  code: EMAIL_UNDELIVERABLE,
  message:
    'We cannot send email to this address. Sign in with a passkey or use a different address.',
};

/**
 * The one place a required mail's failure becomes a public outcome, used by
 * every Better Auth mail hook that cannot proceed without its mail
 * (sign-in, email-change-notice, email-change-confirm or -taken) instead
 * of each hook repeating its own try/catch: a send failure is the retryable
 * EMAIL_DELIVERY_FAILED, a suppressed recipient `refusal` (by default the
 * same EMAIL_UNDELIVERABLE the sign-in gate answers).
 */
export const sendOrUnavailable = async (
  deliver: Deliver,
  message: AuthEmailMessage,
  refusal: UndeliverableRefusal = SUPPRESSED_RECIPIENT,
): Promise<void> => {
  let outcome: Awaited<ReturnType<Deliver>>;
  try {
    outcome = await deliver(message);
  } catch {
    throw unavailable(
      'EMAIL_DELIVERY_FAILED',
      'We could not send the email. Please try again.',
    );
  }
  if (outcome === 'suppressed') throw undeliverable(refusal);
};
