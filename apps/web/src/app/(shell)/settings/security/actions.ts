'use server';

import { headers } from 'next/headers';
import { requestEmailChange } from '../../../../features/account/request-email-change';
import { inProcessFetch } from '../../../../server/in-process-fetch';
import { processRoute } from '../../../../server/process-app';
import {
  submitEmailChange,
  type EmailChangeState,
} from '../../../../ui/settings/security/email-change-state';

const authRoute = processRoute((routes) => routes.auth.POST);

/**
 * The email-change form's POST, as a server action: a change can start
 * before hydration and without JavaScript. It runs the mounted
 * POST /api/auth/change-email handler in process with this request's
 * headers, so the same-origin, session, fresh-session and rate-limit gates
 * all apply. The form is read defensively; the answer is action state,
 * never a URL.
 */
export async function changeEmailAction(
  _state: EmailChangeState,
  form: unknown,
): Promise<EmailChangeState> {
  const send = inProcessFetch(authRoute, new Headers(await headers()));
  return submitEmailChange(
    (newEmail) => requestEmailChange(newEmail, send),
    form instanceof FormData ? form : new FormData(),
  );
}
