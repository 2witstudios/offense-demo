import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, freshSessionMiddleware } from 'better-auth/api';

// ADR 0020: removing a credential, revoking another session, and starting an
// email change are sensitive enough to need a session created within the
// last SESSION_FRESH_AGE_SECONDS, not merely a live one. Registration
// (`/passkey/generate-register-options`, `/passkey/verify-registration`) and
// listing sessions already carry this check inside their own plugins; these
// four do not, so this hook adds it uniformly.
const FRESH_SESSION_PATHS = new Set([
  '/passkey/delete-passkey',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/change-email',
]);

export const freshSessionGatePlugin: BetterAuthPlugin = {
  id: 'offense-demo-fresh-session-gate',
  hooks: {
    before: [
      {
        matcher: (context) =>
          context.path !== undefined && FRESH_SESSION_PATHS.has(context.path),
        // A `hooks.before` handler's return value short-circuits the request
        // as the response body, unlike a `use:` middleware's, which merges
        // into context. Only the throw-on-stale side effect is wanted here,
        // so the checked session is discarded.
        handler: createAuthMiddleware(async (context) => {
          // These paths are only ever reached over HTTP, so `request` is
          // always present here; `freshSessionMiddleware`'s declared type
          // (built for a `use:` endpoint context) requires it non-optional.
          await freshSessionMiddleware(
            context as Parameters<typeof freshSessionMiddleware>[0],
          );
        }),
      },
    ],
  },
};
