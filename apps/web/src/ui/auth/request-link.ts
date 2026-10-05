import { onboardingHref } from '../../features/access/decision';
import type { LinkRequestOutcome } from './sign-in-port';
import {
  initialSignInState,
  signInReducer,
  type SignInState,
} from './sign-in-state';
import { EMAIL_UNDELIVERABLE } from '../../features/auth/undeliverable-codes';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type RequestLink = (email: string) => Promise<LinkRequestOutcome>;

/** What the sign-in form shows after a post: the address as typed, and how the request ended. */
export type LinkFormState = {
  readonly email: string;
  readonly outcome?: LinkRequestOutcome;
};

export const initialLinkForm: LinkFormState = { email: '' };

const UNAVAILABLE: LinkRequestOutcome = { kind: 'unavailable' };

const errorCode = async (response: Response): Promise<unknown> => {
  try {
    return ((await response.json()) as { code?: unknown }).code;
  } catch {
    return undefined;
  }
};

const refusal = async (response: Response): Promise<LinkRequestOutcome> => {
  if (response.status === 429) return { kind: 'rate-limited' };
  return (await errorCode(response)) === EMAIL_UNDELIVERABLE
    ? { kind: 'undeliverable' }
    : UNAVAILABLE;
};

/**
 * A link request over POST /api/auth/sign-in/magic-link, landing on the
 * already validated `destination`, with a new account routed through
 * username onboarding on the way. It never says whether an account exists.
 */
export const createRequestLink =
  (fetchImpl: FetchLike, destination: string): RequestLink =>
  async (email) => {
    let response: Response;
    try {
      response = await fetchImpl('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          callbackURL: destination,
          newUserCallbackURL: onboardingHref(destination),
        }),
      });
    } catch {
      return UNAVAILABLE;
    }
    return response.ok ? { kind: 'sent' } : refusal(response);
  };

const postedEmail = (form: FormData): string => {
  const field = form.get('email');
  return typeof field === 'string' ? field.trim() : '';
};

/**
 * One posted sign-in form. The form is untrusted: a missing or non-text
 * field is an empty address, which the route refuses. A request that throws
 * is unavailable, never sent.
 */
export async function submitLinkRequest(
  requestLink: RequestLink,
  form: FormData,
): Promise<LinkFormState> {
  const email = postedEmail(form);
  let outcome: LinkRequestOutcome;
  try {
    outcome = await requestLink(email);
  } catch {
    outcome = UNAVAILABLE;
  }
  return { email, outcome };
}

/**
 * A posted form whose request never reached the server, because the
 * browser's call to the action failed in transport.
 */
export const linkUnavailable = (form: FormData): LinkFormState => ({
  email: postedEmail(form),
  outcome: UNAVAILABLE,
});

/**
 * The state a page render starts from: where the last posted form ended,
 * with a sent link's cooldown counted from `at` (UTC ISO, this render's
 * clock). Without JavaScript, every post renders the page again from here.
 */
export const signInStateFrom = (
  { email, outcome }: LinkFormState,
  at: string,
): SignInState =>
  outcome === undefined
    ? initialSignInState(email)
    : signInReducer(
        { step: 'enter-email', email, pending: 'link' },
        { type: 'link-settled', outcome, at },
      );
