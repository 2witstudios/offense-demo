'use server';

import { headers } from 'next/headers';
import { returnableDestination } from '../../../../features/auth/redirect';
import { moveOn } from '../../../../server/form-action';
import type { DeclineState } from '../../../../ui/auth/onboarding/decline-offer';

/**
 * The passkey offer's decline choices (shared computer, or not now), as a
 * server action: both are real form POSTs, so they work before hydration
 * and without JavaScript. `next` is validated again here with the same
 * helper the page used, never trusted as a redirect target as posted.
 */
export async function declinePasskeyAction(
  next: unknown,
  _state: DeclineState,
  _form: unknown,
): Promise<DeclineState> {
  const destination = returnableDestination(
    typeof next === 'string' ? next : undefined,
  );
  return moveOn(new Headers(await headers()), destination);
}
