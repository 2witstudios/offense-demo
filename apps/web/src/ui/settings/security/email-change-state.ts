import type { SecurityOutcome } from '../../../features/account/security-client';
import { OUTCOME_NOTICES } from './security-notices';

/** What the email-change form shows: the address as posted, and the answer. */
export type EmailChangeState = {
  readonly newEmail: string;
  readonly outcome?: SecurityOutcome['kind'];
};

export const initialEmailChange: EmailChangeState = { newEmail: '' };

export type ChangeEmail = (newEmail: string) => Promise<SecurityOutcome>;

const postedEmail = (form: FormData): string => {
  const field = form.get('newEmail');
  return typeof field === 'string' ? field.trim() : '';
};

/**
 * One posted email-change form. The form is untrusted: a missing or
 * non-text field is an empty address, which the route refuses. A change
 * that throws is unavailable, never ok.
 */
export async function submitEmailChange(
  change: ChangeEmail,
  form: FormData,
): Promise<EmailChangeState> {
  const newEmail = postedEmail(form);
  try {
    return { newEmail, outcome: (await change(newEmail)).kind };
  } catch {
    return { newEmail, outcome: 'unavailable' };
  }
}

/**
 * A posted form whose change never reached the server, because the
 * browser's call to the action failed in transport.
 */
export const emailChangeUnavailable = (form: FormData): EmailChangeState => ({
  newEmail: postedEmail(form),
  outcome: 'unavailable',
});

export type EmailChangeNotice = {
  readonly tone: 'error' | 'info';
  readonly title: string;
};

/** What the form says about its last answer, if anything. */
export const emailChangeNotice = ({
  outcome,
}: EmailChangeState): EmailChangeNotice | undefined => {
  if (outcome === undefined) return undefined;
  return outcome === 'ok'
    ? {
        tone: 'info',
        title:
          'Check the inbox for the address currently on file to approve this change.',
      }
    : { tone: 'error', title: OUTCOME_NOTICES[outcome] };
};

/**
 * Whether the answer refuses the typed address itself, so the field is
 * marked invalid and points at the notice. When the address on file is
 * the one that cannot receive email, the typed address is not at fault.
 */
export const refusesNewAddress = ({ outcome }: EmailChangeState): boolean =>
  outcome === 'undeliverable';
