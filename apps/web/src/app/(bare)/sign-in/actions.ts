'use server';

import { headers } from 'next/headers';
import { returnableDestination } from '../../../features/auth/redirect';
import { inProcessFetch } from '../../../server/in-process-fetch';
import { processRoute } from '../../../server/process-app';
import {
  createRequestLink,
  submitLinkRequest,
  type LinkFormState,
} from '../../../ui/auth/request-link';

const authRoute = processRoute((routes) => routes.auth.POST);

/**
 * The sign-in form's POST, as a server action: a link can be requested
 * before hydration and without JavaScript. It runs the mounted
 * POST /api/auth/sign-in/magic-link handler in process with this request's
 * headers, so the same-origin, rate-limit and delivery gates all apply.
 * Every argument comes from the browser: `next` is validated again and the
 * form is read defensively. The answer is action state, never a URL.
 */
export async function requestLinkAction(
  next: unknown,
  _state: LinkFormState,
  form: unknown,
): Promise<LinkFormState> {
  const requestLink = createRequestLink(
    inProcessFetch(authRoute, new Headers(await headers())),
    returnableDestination(typeof next === 'string' ? next : undefined),
  );
  return submitLinkRequest(
    requestLink,
    form instanceof FormData ? form : new FormData(),
  );
}
