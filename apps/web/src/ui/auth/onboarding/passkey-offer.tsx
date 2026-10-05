'use client';

import { useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import { authClient } from '../../../lib/auth-client';
import { useFormAction, type FormAction } from '../../form-action/form-action';
import { SavePasskey } from '../save-passkey/save-passkey';
import {
  declineUnavailable,
  initialDecline,
  type DeclineState,
} from './decline-offer';
import {
  createPasskeyEnrollment,
  enrollSafely,
  type PasskeyEnrollmentSeam,
} from './passkey-enrollment';
import {
  initialPasskeyOffer,
  passkeyOfferReducer,
} from './passkey-offer-state';

const supportsPasskeys = () =>
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential === 'function';
const enrollOverAuthClient: PasskeyEnrollmentSeam = createPasskeyEnrollment({
  client: authClient,
  supportsPasskeys,
});

/**
 * The passkey offer right after a claimed username. `destination` was
 * validated by the server page. Declining posts to a server action, so it
 * works before hydration and without JavaScript; a saved passkey leaves by
 * a full navigation so the next render sees the finished account, while
 * declining only navigates the route.
 */
export function PasskeyOffer({
  username,
  destination,
  decline,
  passkeys = enrollOverAuthClient,
}: {
  readonly username: string;
  readonly destination: string;
  readonly decline: FormAction<DeclineState>;
  readonly passkeys?: PasskeyEnrollmentSeam;
}) {
  const [state, dispatch] = useReducer(
    passkeyOfferReducer,
    initialPasskeyOffer,
  );
  const [declined, postDecline, declining] = useFormAction(
    decline,
    initialDecline,
    declineUnavailable,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.step === 'done') window.location.assign(destination);
  }, [state.step, destination]);
  useEffect(() => {
    if (declined.next !== undefined) router.replace(declined.next);
  }, [declined.next, router]);

  if (state.step === 'done') return null;
  const pending = state.saving || declining || declined.next !== undefined;
  return (
    <SavePasskey
      username={username}
      pending={pending}
      notice={state.notice}
      decline={postDecline}
      savePasskey={() => {
        if (pending) return;
        dispatch({ type: 'enroll-started' });
        void enrollSafely(passkeys).then((outcome) =>
          dispatch({ type: 'enroll-settled', outcome }),
        );
      }}
    />
  );
}
