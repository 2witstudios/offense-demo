import type { Logger } from '@offense-demo/logger';
import { handleOperation, requireSameOriginForm } from '../../server/http';
import { renderEmailConfirmPage } from './confirm-email-page';
import { EMAIL_CHANGE_VERIFY_PATH } from './email-change';
import { SESSION_CLEANUP_FAILED_HEADER } from './revoke-others-on-email-change';
import {
  createForward,
  createViewHeadHandlers,
  readForm,
  redirect,
  type ConfirmAuth,
} from './confirm-http-shared';
import { EMAIL_UNDELIVERABLE } from './undeliverable-codes';

const MAX_FORM_BYTES = 4096;
// An opaque 256-bit emailed-link token (`emailed-link-token.ts`): nothing
// else is ever forwarded.
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
// Both hops end in account security settings; the link carries no
// destination, only the token.
const DESTINATION = '/settings/security';

type ConfirmEmailDependencies = {
  readonly auth: ConfirmAuth;
  readonly logger: Logger;
};

/**
 * ISSUE-104: the approval hop refuses a new address suppressed since the
 * request (its confirmation is never sent); the person is told why rather
 * than shown the expired-link page. Anything else is a spent link.
 */
async function refusal(
  response: Response,
  request: Request,
): Promise<Response> {
  const body = (await response.json().catch(() => ({}))) as {
    readonly code?: unknown;
  };
  return response.status === 422 && body.code === EMAIL_UNDELIVERABLE
    ? renderEmailConfirmPage({ kind: 'undeliverable' }, request, 422)
    : renderEmailConfirmPage({ kind: 'expired' }, request, 400);
}

export function createConfirmEmailHandlers({
  auth,
  logger: baseLogger,
}: ConfirmEmailDependencies) {
  const forward = createForward(auth);

  const view = (request: Request): Response => {
    const token = new URL(request.url).searchParams.get('token');
    return token && tokenShape.test(token)
      ? renderEmailConfirmPage({ kind: 'confirm', token }, request)
      : renderEmailConfirmPage({ kind: 'expired' }, request, 400);
  };

  const redeem = async (
    request: Request,
    form: URLSearchParams,
    logger: Logger,
  ) => {
    const token = form.get('token') ?? '';
    if (!tokenShape.test(token))
      return renderEmailConfirmPage({ kind: 'expired' }, request, 400);
    const response = await forward(
      request,
      `/api/auth${EMAIL_CHANGE_VERIFY_PATH}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      },
    );
    if (!response.ok) return refusal(response, request);
    const cookies = response.headers.getSetCookie();
    // Only the final hop (proving live access to the new mailbox) sets a
    // session cookie; the old-address approval hop hits this same route
    // without one. This redemption bypasses the mounted-route wrapper (it
    // forwards straight into Better Auth), so this is the one place the
    // milestone is observable: no token, cookie or address. The atomic
    // revoke of every other session (AUTH-5.6) now runs on the endpoint
    // itself (`revokeOthersOnEmailChangePlugin`, ISSUE-3 AC3), so it can no
    // longer be skipped by any caller of the endpoint; a failure there is
    // best-effort and flagged on the response rather than kept as a second,
    // skippable path here.
    if (cookies.length > 0) {
      logger.log(
        'auth.email_change.verified',
        { operation: 'auth.confirm_email.submit' },
        'Email change verified',
      );
      if (response.headers.get(SESSION_CLEANUP_FAILED_HEADER) === 'true')
        return renderEmailConfirmPage(
          { kind: 'incomplete', callbackURL: DESTINATION },
          request,
          502,
          cookies,
        );
    }
    const headers = new Headers();
    for (const cookie of cookies) headers.append('set-cookie', cookie);
    return redirect(DESTINATION, headers);
  };

  return {
    ...createViewHeadHandlers(baseLogger, 'auth.confirm_email.view', view),
    POST: (request: Request) =>
      handleOperation(
        baseLogger,
        request,
        'auth.confirm_email.submit',
        async (_id, logger) => {
          requireSameOriginForm(request, auth().config.PUBLIC_APP_URL);
          const form = await readForm(request, MAX_FORM_BYTES);
          return redeem(request, form, logger);
        },
      ),
  };
}
