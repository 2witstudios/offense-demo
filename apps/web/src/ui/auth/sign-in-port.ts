/**
 * Outcome of asking for a magic link. It never says whether an account
 * exists: "sent" means the request was accepted, not that mail arrived.
 */
export type LinkRequestOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'undeliverable' }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'unavailable' };

/** Outcome of a passkey sign-in ceremony. Only `signed-in` is a success. */
export type PasskeyOutcome =
  | { readonly kind: 'signed-in' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' };

/**
 * Outcome of one browser-autofill passkey request (conditional mediation).
 * It settles only when a passkey is picked or the request is ended, so each
 * kind says whether autofill should be offered again.
 */
export type PasskeyAutofillOutcome =
  | { readonly kind: 'signed-in' }
  /** A newer ceremony aborted it; that ceremony now owns the page. */
  | { readonly kind: 'superseded' }
  /** The server refused the passkey the person picked. */
  | { readonly kind: 'refused' }
  /** Ended before any pick reached the server: dismissed, or a fault. */
  | { readonly kind: 'interrupted' }
  /** This browser cannot offer passkeys in autofill. */
  | { readonly kind: 'unavailable' };

/**
 * The seam between the sign-in screens and whatever authenticates. The
 * Better Auth adapter implements it by mapping client results onto these
 * outcomes, so the screens never see transport errors.
 */
export type SignInPort = {
  readonly signInWithPasskey: () => Promise<PasskeyOutcome>;
  /** Offers stored passkeys in the browser's autofill on the email field. */
  readonly offerPasskeyAutofill: () => Promise<PasskeyAutofillOutcome>;
};

// The helpers call the port inside `try`: an adapter can throw before it
// returns a promise (client init, argument validation), and a `.catch()` on
// the result would never see that, leaving the screen pending forever.
const settleSafely = async <Outcome>(
  run: () => Promise<Outcome>,
  fallback: Outcome,
): Promise<Outcome> => {
  try {
    return await run();
  } catch {
    return fallback;
  }
};

/** A ceremony that throws is a failure, never a false success. */
export const signInWithPasskeySafely = (
  port: SignInPort,
): Promise<PasskeyOutcome> =>
  settleSafely(() => port.signInWithPasskey(), { kind: 'failed' });

/**
 * An autofill request that throws (a network failure rejects the whole
 * client call) is an interruption: it is retried with backoff, never left
 * dead with an expiring request still in the browser.
 */
export const offerPasskeyAutofillSafely = (
  port: SignInPort,
): Promise<PasskeyAutofillOutcome> =>
  settleSafely(() => port.offerPasskeyAutofill(), { kind: 'interrupted' });
