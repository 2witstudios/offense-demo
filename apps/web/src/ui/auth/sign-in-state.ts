import type {
  LinkRequestOutcome,
  PasskeyAutofillOutcome,
  PasskeyOutcome,
} from './sign-in-port';

/** How long the inbox step waits before offering to resend. */
export const RESEND_COOLDOWN_MS = 60_000;

export type SignInNotice =
  | Exclude<LinkRequestOutcome['kind'], 'sent'>
  | `passkey-${Exclude<PasskeyOutcome['kind'], 'signed-in'>}`;

export type SignInState =
  | {
      readonly step: 'enter-email';
      readonly email: string;
      /** The one request in flight, if any: a link or a passkey ceremony. */
      readonly pending: 'none' | 'link' | 'passkey';
      readonly notice?: SignInNotice;
    }
  | {
      readonly step: 'check-inbox';
      readonly email: string;
      /** UTC ISO time of the last accepted send; drives the resend cooldown. */
      readonly sentAt: string;
      readonly resending: boolean;
    }
  | { readonly step: 'signed-in' };

export type SignInEvent =
  | { readonly type: 'email-typed'; readonly email: string }
  | { readonly type: 'link-requested' }
  | {
      readonly type: 'link-settled';
      readonly outcome: LinkRequestOutcome;
      readonly at: string;
    }
  | { readonly type: 'passkey-requested' }
  | { readonly type: 'passkey-settled'; readonly outcome: PasskeyOutcome }
  | {
      readonly type: 'passkey-autofilled';
      readonly outcome: PasskeyAutofillOutcome;
    }
  | { readonly type: 'change-email' }
  | { readonly type: 'resend-requested'; readonly at: string };

type EnterEmail = Extract<SignInState, { step: 'enter-email' }>;
type CheckInbox = Extract<SignInState, { step: 'check-inbox' }>;

export const initialSignInState = (email = ''): SignInState => ({
  step: 'enter-email',
  email,
  pending: 'none',
});

const idle = (email: string, notice?: SignInNotice): EnterEmail =>
  notice === undefined
    ? { step: 'enter-email', email, pending: 'none' }
    : { step: 'enter-email', email, pending: 'none', notice };

const isIdle = (state: SignInState): state is EnterEmail =>
  state.step === 'enter-email' && state.pending === 'none';

/** Milliseconds until a resend is allowed; both times are UTC ISO strings. */
export const resendRemainingMs = (sentAt: string, now: string): number =>
  Math.max(0, Date.parse(sentAt) + RESEND_COOLDOWN_MS - Date.parse(now));

export const canRequestLink = (state: SignInState): boolean =>
  isIdle(state) && state.email.trim() !== '';

/**
 * Autofill is armed only on screen and while nothing else is in flight on the
 * email step. A hidden tab cannot show autofill, and its refreshes would only
 * overwrite the challenge cookie every tab shares.
 */
export const canOfferPasskeyAutofill = (
  state: SignInState,
  pageVisible: boolean,
): boolean => pageVisible && isIdle(state);

export const canResend = (state: SignInState, now: string): boolean =>
  state.step === 'check-inbox' &&
  !state.resending &&
  resendRemainingMs(state.sentAt, now) === 0;

/** "0:42": whole seconds rounded up, so it never reads 0:00 while waiting. */
export const formatCountdown = (ms: number): string => {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Whether a link request, first send or resend, is awaiting its answer. */
export const linkInFlight = (state: SignInState): boolean =>
  (state.step === 'enter-email' && state.pending === 'link') ||
  (state.step === 'check-inbox' && state.resending);

/** Whether a passkey ceremony started from the button is awaiting its answer. */
export const passkeyInFlight = (state: SignInState): state is EnterEmail =>
  state.step === 'enter-email' && state.pending === 'passkey';

const settleLink = (
  state: SignInState,
  outcome: LinkRequestOutcome,
  at: string,
): SignInState => {
  if (!linkInFlight(state)) return state;
  const { email } = state as EnterEmail | CheckInbox;
  return outcome.kind === 'sent'
    ? { step: 'check-inbox', email, sentAt: at, resending: false }
    : idle(email, outcome.kind);
};

const settlePasskey = (
  state: SignInState,
  outcome: PasskeyOutcome,
): SignInState => {
  if (!passkeyInFlight(state)) return state;
  return outcome.kind === 'signed-in'
    ? { step: 'signed-in' }
    : idle(state.email, `passkey-${outcome.kind}`);
};

/**
 * Autofill is ambient. A verified pick signs in from any step, because the
 * server has already created the session; a refused pick explains itself on
 * an idle email step; every other ending is silent.
 */
const settleAutofill = (
  state: SignInState,
  outcome: PasskeyAutofillOutcome,
): SignInState => {
  if (state.step === 'signed-in') return state;
  if (outcome.kind === 'signed-in') return { step: 'signed-in' };
  return outcome.kind === 'refused' && isIdle(state)
    ? idle(state.email, 'passkey-failed')
    : state;
};

type Transitions = {
  readonly [Type in SignInEvent['type']]: (
    state: SignInState,
    event: Extract<SignInEvent, { type: Type }>,
  ) => SignInState;
};

const transitions: Transitions = {
  'email-typed': (state, { email }) => (isIdle(state) ? idle(email) : state),
  'link-requested': (state) =>
    canRequestLink(state)
      ? { ...idle((state as EnterEmail).email.trim()), pending: 'link' }
      : state,
  'link-settled': (state, { outcome, at }) => settleLink(state, outcome, at),
  'passkey-requested': (state) =>
    isIdle(state) ? { ...idle(state.email), pending: 'passkey' } : state,
  'passkey-settled': (state, { outcome }) => settlePasskey(state, outcome),
  'passkey-autofilled': (state, { outcome }) => settleAutofill(state, outcome),
  'change-email': (state) =>
    state.step === 'check-inbox' && !state.resending
      ? idle(state.email)
      : state,
  'resend-requested': (state, { at }) =>
    canResend(state, at)
      ? { ...(state as CheckInbox), resending: true }
      : state,
};

/** Pure transitions. An event that does not apply returns the same state. */
export const signInReducer = (
  state: SignInState,
  event: SignInEvent,
): SignInState =>
  (
    transitions[event.type] as (
      state: SignInState,
      event: SignInEvent,
    ) => SignInState
  )(state, event);
