import type { ClientError } from '../../features/auth/client-error';
import type {
  PasskeyAutofillOutcome,
  PasskeyOutcome,
  SignInPort,
} from './sign-in-port';

/**
 * The slice of the Better Auth client this adapter uses. Structural, so the
 * adapter is testable without a network and never sees transport types.
 */
export type SignInClient = {
  readonly signIn: {
    readonly passkey: (opts?: {
      autoFill?: boolean;
      /** Better Auth applies these only to the verify request. */
      fetchOptions?: { onRequest?: () => void };
    }) => Promise<{ readonly error: ClientError }>;
  };
};

/**
 * The browser reports every dismissed prompt, timeout and missing credential
 * as one indistinguishable "not allowed" failure, so those are `cancelled`.
 */
const CANCELLED_CODES = new Set([
  'AUTH_CANCELLED',
  'ERROR_CEREMONY_ABORTED',
  'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
]);

const passkeyOutcome = (error: ClientError): PasskeyOutcome => {
  if (error === null) return { kind: 'signed-in' };
  return error.code !== undefined && CANCELLED_CODES.has(error.code)
    ? { kind: 'cancelled' }
    : { kind: 'failed' };
};

/** SimpleWebAuthn's code when a newer ceremony aborted this one. */
const ABORTED = 'ERROR_CEREMONY_ABORTED';

/**
 * Whether the person picked a passkey is known for certain: the verify
 * request only follows a pick. A failure after it is the server refusing
 * that passkey (an expired challenge, a credential it no longer holds, an
 * outage), which the person must hear about; a failure before it is a
 * dismissal or an options fault, which is retried quietly.
 */
const autofillOutcome = (
  error: ClientError,
  picked: boolean,
): PasskeyAutofillOutcome => {
  if (error === null) return { kind: 'signed-in' };
  if (error.code === ABORTED) return { kind: 'superseded' };
  return picked ? { kind: 'refused' } : { kind: 'interrupted' };
};

/**
 * Better Auth's passkey ceremonies behind the sign-in screens: client
 * results become the honest outcomes each screen can show. The emailed link
 * is not here: it is a form post to a server action (`request-link.ts`).
 */
export function createBetterAuthSignInPort({
  client,
  supportsPasskeys,
  supportsPasskeyAutofill,
}: {
  readonly client: SignInClient;
  readonly supportsPasskeys: () => boolean;
  /** Whether the browser can list passkeys in autofill (conditional UI). */
  readonly supportsPasskeyAutofill: () => Promise<boolean>;
}): SignInPort {
  // Every unsettled autofill request, whether pending in the browser or still
  // fetching its options. One still fetching when the button starts reaches
  // the browser later and aborts the button's prompt (SimpleWebAuthn keeps
  // one ceremony at a time), so a button aborted while any is in flight
  // retries once, which then aborts the autofill instead.
  let autofillsInFlight = 0;
  return {
    signInWithPasskey: async () => {
      if (!supportsPasskeys()) return { kind: 'unsupported' };
      const raced = autofillsInFlight > 0;
      const { error } = await client.signIn.passkey();
      return passkeyOutcome(
        raced && error?.code === ABORTED
          ? (await client.signIn.passkey()).error
          : error,
      );
    },
    offerPasskeyAutofill: async () => {
      autofillsInFlight += 1;
      try {
        if (!(await supportsPasskeyAutofill())) return { kind: 'unavailable' };
        let picked = false;
        const { error } = await client.signIn.passkey({
          autoFill: true,
          fetchOptions: {
            onRequest: () => {
              picked = true;
            },
          },
        });
        return autofillOutcome(error, picked);
      } finally {
        autofillsInFlight -= 1;
      }
    },
  };
}
