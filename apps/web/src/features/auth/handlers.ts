import { toNextJsHandler } from 'better-auth/next-js';
import { createAppError, isAppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import { handleOperation } from '../../server/http';
import { EMAIL_CHANGE_VERIFY_PATH } from './email-change';
import { logAuthLifecycle } from './lifecycle-events';

type Handler = (request: Request) => Promise<Response>;

/**
 * The emailed-link redemption endpoints. Better Auth 1.7.5 registers the
 * magic-link one as a GET (`better-auth/dist/plugins/magic-link/index.mjs:116-117`),
 * so a direct link would redeem it without ever crossing the same-origin
 * POST confirm page (`confirm.ts`, `confirm-email.ts`) — a login-CSRF and a
 * `revokeOtherSessionsFor` bypass (ISSUE-3); the email-change one
 * (`email-change.ts`) is held to the same rule. Only the confirm pages' internal
 * forward may redeem: `confirm-http-shared.ts`'s `createForward` calls
 * `server.handler` directly, never through this mounted route, so refusing
 * every request here at the boundary cannot break that forward.
 */
const DIRECT_REDEMPTION_BLOCKED_PATHS = new Set([
  '/magic-link/verify',
  EMAIL_CHANGE_VERIFY_PATH,
]);

/** Strips the mount prefix so only the stable Better Auth path is compared. */
const mountedPath = (url: string): string =>
  new URL(url).pathname.replace(/^\/api\/auth/, '');

/**
 * Copies a Better Auth response into a fresh mutable one without consuming
 * or re-serializing the body; every Set-Cookie header survives verbatim.
 * Adds `Retry-After` (standard) beside Better Auth's `X-Retry-After`.
 */
export function preserve(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const cookie of response.headers.getSetCookie())
    if (!headers.getSetCookie().includes(cookie))
      headers.append('set-cookie', cookie);
  const retry = headers.get('x-retry-after');
  if (retry && !headers.has('retry-after')) headers.set('retry-after', retry);
  if (response.status === 503 && !headers.has('retry-after'))
    headers.set('retry-after', '5');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A 503 mapped from a thrown limiter/infrastructure error advertises a retry. */
const withRetryAfter = (response: Response) =>
  response.status === 503 && !response.headers.has('retry-after')
    ? preserve(response)
    : response;

/**
 * Mounts Better Auth behind the shared operation wrapper: correlation and
 * no-store headers, structured completion logging that never includes the
 * URL, query or credentials, and safe public errors for thrown failures
 * (a limiter outage surfaces as a 503, never as an allowed request).
 */
export function createAuthRouteHandlers(
  auth: () => { handler: Handler; config: { PUBLIC_APP_URL: string } },
  baseLogger: Logger,
) {
  const handle = async (request: Request) =>
    withRetryAfter(
      await handleOperation(
        baseLogger,
        request,
        'auth.request',
        async (_id, logger) => {
          const server = auth();
          if (DIRECT_REDEMPTION_BLOCKED_PATHS.has(mountedPath(request.url)))
            return new Response(null, { status: 404 });
          // Better Auth only enforces origin on cookie-bearing requests; every
          // state-changing auth call must additionally come from our own origin.
          if (
            request.method !== 'GET' &&
            request.method !== 'HEAD' &&
            request.headers.get('origin') !==
              new URL(server.config.PUBLIC_APP_URL).origin
          )
            throw createAppError('AUTHORIZATION');
          try {
            const delegate = toNextJsHandler({ handler: server.handler });
            const method = request.method as keyof typeof delegate;
            const response = await (delegate[method] ?? delegate.GET)(request);
            if (response.status < 400)
              logAuthLifecycle(logger, mountedPath(request.url));
            return preserve(response);
          } catch (error) {
            // Anything unexpected from the framework (a database failure while
            // persisting a token or session) is a retryable outage, never a
            // raw error: details stay in the cause.
            throw isAppError(error)
              ? error
              : createAppError('INFRASTRUCTURE', undefined, error);
          }
        },
      ),
    );
  return {
    GET: handle,
    POST: handle,
    PATCH: handle,
    PUT: handle,
    DELETE: handle,
  };
}
