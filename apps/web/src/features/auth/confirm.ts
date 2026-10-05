import type { Logger } from '@offense-demo/logger';
import { handleOperation, requireSameOriginForm } from '../../server/http';
import { CONFIRM_PATH, renderConfirmPage, type Hidden } from './confirm-page';
import {
  createForward,
  createViewHeadHandlers,
  readForm,
  redirect,
  type ConfirmAuth,
} from './confirm-http-shared';
import { returnableDestination } from './redirect';
import { EMAIL_UNDELIVERABLE } from './undeliverable-codes';

const NEW_USER_DESTINATION = '/onboarding/username';
const EXPIRED = `${CONFIRM_PATH}?error=INVALID_TOKEN`;
const MAX_FORM_BYTES = 4096;
const tokenShape = /^[A-Za-z0-9_-]{16,256}$/;
const emailShape = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}$/;
/** Only fixed, safe codes minted by the auth composition are shown to people. */
const SHOWN_CODES = new Set([
  EMAIL_UNDELIVERABLE,
  'RATE_LIMITED',
  'EMAIL_DELIVERY_FAILED',
  'AUTH_TEMPORARILY_UNAVAILABLE',
]);

type ConfirmDependencies = {
  readonly auth: ConfirmAuth;
  readonly logger: Logger;
};

const hiddenFrom = (params: URLSearchParams): Hidden => {
  const newUser = params.get('newUserCallbackURL');
  return {
    callbackURL: returnableDestination(params.get('callbackURL')),
    ...(newUser
      ? {
          newUserCallbackURL: returnableDestination(
            newUser,
            NEW_USER_DESTINATION,
          ),
        }
      : {}),
  };
};

/**
 * Success redirect: re-validate the target and keep only its path and query.
 * The target is compared with the deployment's public origin, never the
 * request's own: behind TLS termination the request arrives as plain HTTP.
 */
function signedInRedirect(response: Response, publicUrl: string) {
  const location = response.headers.get('location');
  const cookies = response.headers.getSetCookie();
  if (!location || cookies.length === 0) return null;
  const target = new URL(location, publicUrl);
  const sameOrigin = target.origin === new URL(publicUrl).origin;
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return redirect(
    returnableDestination(
      sameOrigin ? `${target.pathname}${target.search}` : null,
    ),
    headers,
  );
}

const retryAfter = (response: Response) =>
  response.headers.get('retry-after') ?? response.headers.get('x-retry-after');

/** The safe public sentence for a failed resend. */
async function resendNotice(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };
  if (body.code && SHOWN_CODES.has(body.code) && body.message)
    return body.message;
  return response.status === 429
    ? 'Too many requests. Please try again later.'
    : 'We could not send the email. Please try again.';
}

/**
 * Rate-limited or transient failure: keep the token in the POST-only form so
 * the person can retry, without ever placing it in a URL.
 */
function retryView(
  token: string,
  hidden: Hidden,
  response: Response,
  request: Request,
) {
  const limited = response.status === 429;
  return renderConfirmPage(
    {
      kind: 'confirm',
      token,
      hidden,
      // The mock's exact retry copy: only the lead sentence is bold.
      notice: limited
        ? {
            lead: 'Too many attempts.',
            rest: 'Wait a minute, then select the button again. Your link still works.',
          }
        : {
            lead: 'We could not complete sign-in.',
            rest: 'Please try again.',
          },
    },
    request,
    limited ? 429 : 503,
    { 'Retry-After': (limited && retryAfter(response)) || '5' },
  );
}

export function createConfirmHandlers({
  auth,
  logger: baseLogger,
}: ConfirmDependencies) {
  const forward = createForward(auth);

  /** GET and HEAD only render: a scanner or prefetch can never redeem. */
  const view = (request: Request): Response => {
    const params = new URL(request.url).searchParams;
    const token = params.get('token');
    const hidden = hiddenFrom(params);
    return token && tokenShape.test(token)
      ? renderConfirmPage({ kind: 'confirm', token, hidden }, request)
      : renderConfirmPage({ kind: 'expired', hidden }, request);
  };

  const redeem = async (
    request: Request,
    form: URLSearchParams,
    logger: Logger,
  ) => {
    const token = form.get('token') ?? '';
    const hidden = hiddenFrom(form);
    if (!tokenShape.test(token)) return redirect(EXPIRED);
    const query = new URLSearchParams({
      token,
      callbackURL: hidden.callbackURL,
      newUserCallbackURL: hidden.newUserCallbackURL ?? NEW_USER_DESTINATION,
      errorCallbackURL: EXPIRED,
    });
    const response = await forward(
      request,
      `/api/auth/magic-link/verify?${query}`,
      { method: 'GET' },
    );
    const signedIn = signedInRedirect(response, auth().config.PUBLIC_APP_URL);
    if (signedIn) {
      // The redemption itself bypasses the mounted-route wrapper (it forwards
      // straight into the Better Auth handler), so this is the one place a
      // successful redemption is observable: no token, cookie or address.
      logger.log(
        'auth.magic_link.verified',
        { operation: 'auth.confirm.submit' },
        'Magic link verified',
      );
      return signedIn;
    }
    if (response.status >= 300 && response.status < 400)
      return redirect(EXPIRED);
    return retryView(token, hidden, response, request);
  };

  const resend = async (request: Request, form: URLSearchParams) => {
    const email = (form.get('email') ?? '').trim();
    const hidden = hiddenFrom(form);
    if (!emailShape.test(email))
      return renderConfirmPage(
        { kind: 'expired', hidden, notice: 'Enter a valid email address.' },
        request,
        400,
      );
    const response = await forward(request, '/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        callbackURL: hidden.callbackURL,
        newUserCallbackURL: hidden.newUserCallbackURL ?? NEW_USER_DESTINATION,
      }),
    });
    if (response.ok) return renderConfirmPage({ kind: 'sent' }, request);
    const retry = retryAfter(response);
    return renderConfirmPage(
      { kind: 'expired', hidden, notice: await resendNotice(response) },
      request,
      [422, 429].includes(response.status) ? response.status : 503,
      retry ? { 'Retry-After': retry } : {},
    );
  };

  return {
    ...createViewHeadHandlers(baseLogger, 'auth.confirm.view', view),
    POST: (request: Request) =>
      handleOperation(
        baseLogger,
        request,
        'auth.confirm.submit',
        async (_id, logger) => {
          requireSameOriginForm(request, auth().config.PUBLIC_APP_URL);
          const form = await readForm(request, MAX_FORM_BYTES);
          return form.get('intent') === 'resend'
            ? resend(request, form)
            : redeem(request, form, logger);
        },
      ),
  };
}
