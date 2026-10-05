'use server';

import { headers } from 'next/headers';
import { passkeyOfferHref } from '../../../../features/access/decision';
import { returnableDestination } from '../../../../features/auth/redirect';
import { moveOn } from '../../../../server/form-action';
import { processRoute } from '../../../../server/process-app';
import {
  submitClaim,
  type UsernameFormState,
} from '../../../../ui/auth/onboarding/claim-form';
import { createClaimUsername } from '../../../../ui/auth/onboarding/claim-username';
import { inProcessFetch } from '../../../../server/in-process-fetch';

const claimRoute = processRoute((routes) => routes.username.POST);

/**
 * The username form's POST, as a server action: the claim works before
 * hydration and without JavaScript. It runs the POST /api/account/username
 * handler in process with this request's headers, so the same-origin,
 * session, rate-limit and claim gates all apply. Every argument comes from
 * the browser: `next` is validated again and the form is read defensively.
 * A claimed (or already named) account moves on (`moveOn`: a 303 without
 * JavaScript, a destination the page navigates to with it), never by a
 * username in a URL.
 */
export async function claimUsernameAction(
  next: unknown,
  _state: UsernameFormState,
  form: unknown,
): Promise<UsernameFormState> {
  const destination = returnableDestination(
    typeof next === 'string' ? next : undefined,
  );
  const incoming = new Headers(await headers());
  const claim = createClaimUsername(inProcessFetch(claimRoute, incoming));
  const result = await submitClaim(
    claim,
    form instanceof FormData ? form : new FormData(),
  );
  if (result.kind === 'refused') return result.state;
  return {
    username: '',
    ...moveOn(
      incoming,
      result.kind === 'claimed' ? passkeyOfferHref(destination) : destination,
    ),
  };
}
