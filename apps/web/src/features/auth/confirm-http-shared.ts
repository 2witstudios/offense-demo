import { createAppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import { handleOperation } from '../../server/http';
import {
  parseThemePreference,
  preferenceFromCookies,
  type ThemePreference,
} from '../../ui/theme/theme-preference';
import { readBoundedBody } from './bounded-body';
import { CLIENT_IP_HEADER } from './client-ip';

export type PageContext = {
  /** Absent when `x-nonce` is missing or malformed: the page then renders
   * with no `<style>` at all, rather than trust an unvalidated value. */
  readonly nonce: string | undefined;
  readonly theme: ThemePreference;
};

// `proxy-handler.ts` encodes 16 CSPRNG bytes as base64: exactly 22 base64
// characters plus the fixed "==" padding those 16 bytes always produce.
const NONCE_SHAPE = /^[A-Za-z0-9+/]{22}==$/;

/** Pure: derives the nonce and theme every confirm-page render needs. */
export function pageContext(request: Request): PageContext {
  const rawNonce = request.headers.get('x-nonce');
  const nonce = rawNonce && NONCE_SHAPE.test(rawNonce) ? rawNonce : undefined;
  const cookie = request.headers.get('cookie');
  const theme = cookie
    ? preferenceFromCookies(cookie)
    : parseThemePreference(undefined);
  return { nonce, theme };
}

export type ConfirmAuth = () => {
  readonly handler: (request: Request) => Promise<Response>;
  readonly config: { readonly PUBLIC_APP_URL: string };
};

export const redirect = (location: string, headers = new Headers()) => {
  headers.set('Location', location);
  return new Response(null, { status: 303, headers });
};

/** Bounded form-body parsing shared by every confirm-page POST handler. */
export async function readForm(
  request: Request,
  maxBytes: number,
): Promise<URLSearchParams> {
  const body = request.headers
    .get('content-type')
    ?.startsWith('application/x-www-form-urlencoded')
    ? await readBoundedBody(request, maxBytes)
    : null;
  if (body === null) throw createAppError('VALIDATION');
  return new URLSearchParams(body.toString('utf8'));
}

/** Same-origin, identity-stamped sub-request into the mounted Better Auth router. */
export function createForward(auth: ConfirmAuth) {
  return (request: Request, path: string, init: RequestInit) => {
    const server = auth();
    const headers = new Headers(init.headers);
    headers.set('origin', new URL(server.config.PUBLIC_APP_URL).origin);
    const client = request.headers.get(CLIENT_IP_HEADER);
    if (client) headers.set(CLIENT_IP_HEADER, client);
    // An unexpected framework failure becomes a plain 503 the views retry.
    // `server.handler` now throws a typed INFRASTRUCTURE error on such a
    // failure (server.ts) rather than swallowing it to a bare 500 Response,
    // so this catch is the one place that failure is converted into the
    // graceful fallback the confirm pages already render for it.
    return server
      .handler(
        new Request(new URL(path, server.config.PUBLIC_APP_URL), {
          ...init,
          headers,
        }),
      )
      .catch(() => new Response(null, { status: 503 }));
  };
}

/** GET renders; HEAD renders the same status/headers with no body. Neither redeems. */
export function createViewHeadHandlers(
  logger: Logger,
  operation: string,
  view: (request: Request) => Response,
) {
  return {
    GET: (request: Request) =>
      handleOperation(logger, request, operation, async () => view(request)),
    HEAD: (request: Request) =>
      handleOperation(logger, request, operation, async () => {
        const rendered = view(request);
        return new Response(null, {
          status: rendered.status,
          headers: rendered.headers,
        });
      }),
  };
}
