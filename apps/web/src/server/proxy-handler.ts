import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import type { IdGenerator } from '@offense-demo/clock';
import { isValidTraceparent } from '@offense-demo/observability';
import { isGuardedPath, signInHref } from '../features/access/decision';
import { returnableDestination } from '../features/auth/redirect';
import { hasSessionCookie } from '../features/auth/session-cookie';
// A nonce never authorizes a `style="…"` attribute, and `next/image` always
// server-renders one. Hash the exact strings it emits (`fill`, and the default)
// so every other inline style attribute stays refused. The CSP e2e fails if a
// Next upgrade changes them. CSP mandates SHA-2 here; nothing secret is hashed.
const styleAttributeSources = [
  'position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;color:transparent',
  'color:transparent',
]
  .map(
    (style) =>
      `'sha256-${createHash('sha256').update(style).digest('base64')}'`,
  )
  .join(' ');

/** What the proxy reads from validated server configuration. */
export type ProxySettings = {
  /** `PUBLIC_APP_URL`. */
  readonly publicAppUrl: string;
  /** `NODE_ENV === 'development'`: the permissive dev-server policy. */
  readonly development: boolean;
  readonly ids: IdGenerator;
};

/**
 * Early hint only: a guarded request with no session cookie at all can never
 * pass, so skip the render. Whether a cookie is a live session is decided
 * per entrypoint (lib/access.ts), which rechecks the durable session.
 */
function signInHint(
  request: NextRequest,
  policy: string,
  requestId: string,
  publicAppUrl: string,
): NextResponse | null {
  const { pathname, search } = request.nextUrl;
  if (!isGuardedPath(pathname) || hasSessionCookie(request.headers))
    return null;
  // Proxy redirects must be absolute. Behind TLS termination the request's
  // own origin is plain HTTP, and the Host header is caller-controlled, so
  // the target is the validated configured public origin and nothing else.
  const origin = new URL(publicAppUrl).origin;
  const next = returnableDestination(`${pathname}${search}`);
  const response = NextResponse.redirect(new URL(signInHref(next), origin));
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('x-request-id', requestId);
  return response;
}

/**
 * Every request's first stop (bound in `proxy.ts`): the CSP nonce and policy, the early sign-in hint, and trusted
 * correlation headers.
 */
export function handleProxy(request: NextRequest, settings: ProxySettings) {
  const requestId = settings.ids.next();
  // 16 CSPRNG bytes: a cuid2 value (the injected ids) is never a secret (AGENTS.md),
  // and the nonce must be unguessable, unlike the request-id above.
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString('base64');
  const { development } = settings;
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    ...(development
      ? []
      : [`style-src-attr 'unsafe-hashes' ${styleAttributeSources}`]),
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `connect-src 'self'${development ? ' ws:' : ''}`,
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
  const hint = signInHint(request, policy, requestId, settings.publicAppUrl);
  if (hint) return hint;
  const headers = new Headers(request.headers);
  // Never trust caller-supplied identifiers; proxy ingress establishes correlation.
  headers.set('x-request-id', requestId);
  if (!isValidTraceparent(headers.get('traceparent')))
    headers.delete('traceparent');
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('x-request-id', requestId);
  return response;
}
