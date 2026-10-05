import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

/**
 * Keys no browser-reachable auth response may carry (ISSUE-5 AC7): the
 * session token is the httpOnly cookie's own value, and `ipAddress` is the
 * raw client address. Better Auth returns both in `/get-session`,
 * `/passkey/verify-authentication` and `/passkey/verify-registration` (with
 * `createSession`), and the browser client reads neither.
 */
const BROWSER_HIDDEN_KEYS = new Set(['token', 'ipAddress']);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A copy without the hidden keys at any depth; Dates and other values pass through. */
export const withoutBrowserHiddenKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutBrowserHiddenKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !BROWSER_HIDDEN_KEYS.has(key))
      .map(([key, inner]) => [key, withoutBrowserHiddenKeys(inner)]),
  );
};

/**
 * Shapes every JSON response the mounted `/api/auth/*` handler sends, on
 * every path, so a new endpoint cannot reintroduce the leak. It acts only on
 * HTTP requests: server code calling `auth.api.*` (no Request) keeps the
 * token it needs to revoke a session by id. Registered last, so every other
 * plugin's after hook has already seen the full result.
 */
export const browserSessionShapePlugin: BetterAuthPlugin = {
  id: 'offense-demo-browser-session-shape',
  hooks: {
    after: [
      {
        matcher: () => true,
        handler: createAuthMiddleware(async (context) => {
          const returned = context.context.returned;
          if (
            context.request === undefined ||
            !(Array.isArray(returned) || isPlainObject(returned))
          )
            return;
          return context.json(
            withoutBrowserHiddenKeys(returned) as Record<string, unknown>,
          );
        }),
      },
    ],
  },
};
