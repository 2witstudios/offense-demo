import { parseUsername } from '@offense-demo/auth';
import type { ClaimUsername } from './claim-username';

export type UsernameNotice =
  'invalid' | 'taken' | 'signed-out' | 'rate-limited' | 'unavailable';

/**
 * What the username form shows: the name as typed, and why it was refused;
 * or, once the account has its name, where the page goes next.
 */
export type UsernameFormState = {
  readonly username: string;
  readonly notice?: UsernameNotice;
  readonly next?: string;
};

export const initialUsernameForm: UsernameFormState = { username: '' };

/** How one posted claim ended. Only `claimed` and `already-set` move on. */
export type ClaimSubmission =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'already-set' }
  | { readonly kind: 'refused'; readonly state: UsernameFormState };

/** The local shape check, run in the browser and again on the server. */
export const refusesShape = (username: string): boolean =>
  !parseUsername(username).ok;

const refused = (
  username: string,
  notice: UsernameNotice,
): ClaimSubmission => ({ kind: 'refused', state: { username, notice } });

const postedUsername = (form: FormData): string => {
  const field = form.get('username');
  return typeof field === 'string' ? field : '';
};

/**
 * One posted username form, claimed through `claim`. The form is untrusted:
 * a missing or non-text field is an empty name, and a malformed name is
 * refused before any claim. A claim that throws is unavailable, never a
 * success.
 */
export async function submitClaim(
  claim: ClaimUsername,
  form: FormData,
): Promise<ClaimSubmission> {
  const username = postedUsername(form);
  if (refusesShape(username)) return refused(username, 'invalid');
  let outcome: Awaited<ReturnType<ClaimUsername>>;
  try {
    outcome = await claim(username);
  } catch {
    return refused(username, 'unavailable');
  }
  if (outcome.kind === 'claimed' || outcome.kind === 'already-set')
    return { kind: outcome.kind };
  return refused(username, outcome.kind);
}

/**
 * A posted form whose claim never reached the server, because the
 * browser's call to the action failed in transport.
 */
export const claimUnavailable = (form: FormData): UsernameFormState => ({
  username: postedUsername(form),
  notice: 'unavailable',
});

/**
 * What the browser adds to the server's answer: its own refusal of a
 * malformed name, or `edited` once the person typed since that answer.
 */
export type LocalNotice = 'invalid' | 'edited' | undefined;

/**
 * The notice the form shows. A pending claim shows none: the server's last
 * answer was about the name before it, and its refusal must not come back
 * for the new name while that one is in flight.
 */
export const shownNotice = ({
  local,
  answered,
  pending,
}: {
  readonly local: LocalNotice;
  readonly answered: UsernameNotice | undefined;
  readonly pending: boolean;
}): UsernameNotice | undefined => {
  if (pending || local === 'edited') return undefined;
  return local ?? answered;
};
