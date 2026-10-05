import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { Logger } from '@offense-demo/logger';
import { EMAIL_CHANGE_VERIFY_PATH } from './email-change';

/** Set on the response when the atomic revoke below fails, so the confirm
 * page can still tell the person their other sessions were not confirmed
 * signed out, without the endpoint itself needing a second, skippable path
 * to reach that decision. */
export const SESSION_CLEANUP_FAILED_HEADER =
  'x-offense-demo-session-cleanup-failed';

/**
 * ISSUE-3 AC3: the email change's final hop (`/email-change/verify`
 * redeeming a verify-purpose token, the one that sets a session cookie,
 * proving live access to the new mailbox) must revoke every other session
 * for the account (AUTH-5.6), whoever calls the endpoint: the confirm page,
 * a direct request, or `auth.api.verifyEmailChange`. A `hooks.after`
 * matcher on the endpoint itself cannot be skipped by the caller: Better
 * Auth runs it for the HTTP router and for `auth.api.*` alike
 * (`dispatchAuthEndpoint` is the one hook runner both go through).
 *
 * Best-effort, like `sessionRevokedOutboxPlugin`: a revoke failure must never
 * turn an already-verified email and already-issued session into a reported
 * failure for the person. It is logged as a registered event and flagged on
 * the response via a header instead, so the confirm page can still say the
 * cleanup step failed.
 */
export const revokeOthersOnEmailChangePlugin = (
  revokeOtherSessions: (userId: string, keepToken: string) => Promise<number>,
  logger: Logger,
): BetterAuthPlugin => ({
  id: 'offense-demo-revoke-others-on-email-change',
  hooks: {
    after: [
      {
        matcher: (context) => context.path === EMAIL_CHANGE_VERIFY_PATH,
        handler: createAuthMiddleware(async (context) => {
          const newSession = context.context.newSession;
          if (!newSession) return;
          try {
            await revokeOtherSessions(
              newSession.user.id,
              newSession.session.token,
            );
          } catch {
            context.context.responseHeaders?.set(
              SESSION_CLEANUP_FAILED_HEADER,
              'true',
            );
            logger.log(
              'auth.email_change.cleanup_failed',
              { operation: 'auth.verify_email' },
              'Could not revoke other sessions after a confirmed email change',
            );
          }
        }),
      },
    ],
  },
});
