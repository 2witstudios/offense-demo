import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

/**
 * `@offense-demo/db`'s `revokeSessionUnlessAddressHeld`: deletes the session
 * `token` unless its account still holds `email`; `true` when it did.
 */
export type RevokeSessionUnlessAddressHeld = (input: {
  readonly token: string;
  readonly email: string;
}) => Promise<boolean>;

const MAGIC_LINK_VERIFY_PATH = '/magic-link/verify';

/**
 * ISSUE-103: Better Auth 1.7.5's `/magic-link/verify` finds the account by
 * the link's address and creates the session in separate statements, so an
 * email change can complete in between. Its revoke-all then runs before the
 * session exists, and the session would outlive the change on an account
 * that no longer holds the address the link proved. After the session has
 * committed, this re-checks the address in one statement and, when the
 * account has moved, removes the session, drops its cookie and answers as
 * Better Auth does for a spent link. An `after` hook on the endpoint itself,
 * so every caller (the confirm page, `auth.api.*`) goes through it.
 */
export const signInAddressGuardPlugin = (
  revokeSessionUnlessAddressHeld: RevokeSessionUnlessAddressHeld,
): BetterAuthPlugin => ({
  id: 'offense-demo-sign-in-address-guard',
  hooks: {
    after: [
      {
        matcher: (context) => context.path === MAGIC_LINK_VERIFY_PATH,
        handler: createAuthMiddleware(async (context) => {
          const newSession = context.context.newSession;
          if (!newSession) return;
          // The account was found by the link's address, so the user row
          // read then carries exactly the address the link proved.
          const revoked = await revokeSessionUnlessAddressHeld({
            token: newSession.session.token,
            email: newSession.user.email,
          });
          if (!revoked) return;
          context.context.responseHeaders?.delete('set-cookie');
          const query = context.query as
            { callbackURL?: string; errorCallbackURL?: string } | undefined;
          // Better Auth's own spent-link answer (`redirectWithError`).
          const target = new URL(
            decodeURIComponent(
              query?.errorCallbackURL ?? query?.callbackURL ?? '/',
            ),
            context.context.baseURL,
          );
          target.searchParams.set('error', 'INVALID_TOKEN');
          throw context.redirect(target.toString());
        }),
      },
    ],
  },
});
