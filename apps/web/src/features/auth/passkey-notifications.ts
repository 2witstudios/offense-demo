import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import type { Logger } from '@offense-demo/logger';
import { renderAuthEmail } from './mail/templates';
import type { Deliver } from './deliver-or-unavailable';

const NOTIFIED_PATHS: Readonly<
  Record<string, 'passkey-added' | 'passkey-removed'>
> = {
  '/passkey/verify-registration': 'passkey-added',
  '/passkey/delete-passkey': 'passkey-removed',
};

/**
 * Sends the `mail/templates.ts` passkey notices to the account's verified
 * email, so a hijacked fresh session adding a permanent passkey, or an
 * attacker with a stolen one removing the owner's, never goes unnoticed by
 * the owner. Both mounted paths require
 * `sessionMiddleware` (`@better-auth/passkey`), so `context.context.session`
 * is always the acting account here.
 *
 * Best-effort, like `revokeOthersOnEmailChangePlugin`: a notification
 * failure must never turn an already-completed passkey change into a
 * reported failure for the person who just added or removed it. A
 * suppressed address is skipped by `deliver` itself (ISSUE-54), which logs
 * `auth.mail.suppressed`; that is not a failure.
 */
export const passkeyNotificationsPlugin = (
  origin: string,
  deliver: Deliver,
  logger: Logger,
): BetterAuthPlugin => ({
  id: 'offense-demo-passkey-notifications',
  hooks: {
    after: [
      {
        matcher: (context) =>
          context.path !== undefined && context.path in NOTIFIED_PATHS,
        handler: createAuthMiddleware(async (context) => {
          if (isAPIError(context.context.returned)) return;
          const kind = NOTIFIED_PATHS[context.path];
          const email = context.context.session?.user.email;
          if (!kind || typeof email !== 'string') return;
          const message = renderAuthEmail({
            kind,
            url: `${origin}/settings/security`,
          });
          try {
            await deliver({ to: email, ...message });
          } catch {
            logger.log(
              'auth.passkey.notification_failed',
              { operation: 'auth.passkey_notify' },
              'Could not send the passkey change notification',
            );
          }
        }),
      },
    ],
  },
});
