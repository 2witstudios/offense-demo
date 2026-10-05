'use client';

import { useCallback } from 'react';
import { systemClock } from '@offense-demo/clock';
import { authClient } from '../../../lib/auth-client';
import { createBetterAuthSignInPort } from '../better-auth-sign-in-port';
import {
  SignInFlow,
  type RequestLinkAction,
} from '../sign-in-flow/sign-in-flow';

const supportsPasskeys = () =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function';

const supportsPasskeyAutofill = async () =>
  supportsPasskeys() &&
  typeof window.PublicKeyCredential.isConditionalMediationAvailable ===
    'function' &&
  (await window.PublicKeyCredential.isConditionalMediationAvailable());

const port = createBetterAuthSignInPort({
  client: authClient,
  supportsPasskeys,
  supportsPasskeyAutofill,
});

/**
 * The live sign-in: emailed links through `requestLink`, a server action
 * bound to the destination the server page validated, and passkeys through
 * Better Auth over the real /api/auth handler. A full navigation follows a
 * passkey sign-in so the next server render sees the new cookie.
 */
export function SignIn({
  destination,
  requestLink,
}: {
  readonly destination: string;
  readonly requestLink: RequestLinkAction;
}) {
  const onSignedIn = useCallback(
    () => window.location.assign(destination),
    [destination],
  );
  return (
    <SignInFlow
      port={port}
      requestLink={requestLink}
      clock={systemClock}
      onSignedIn={onSignedIn}
    />
  );
}
