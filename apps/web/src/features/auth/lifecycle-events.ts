import type { EventName, Logger } from '@offense-demo/logger';

/**
 * Better Auth paths whose successful outcome is a distinct auth lifecycle
 * milestone worth its own event, beyond the generic `http.request.completed`
 * (which shares one operation name across every mounted route and cannot
 * distinguish them). Only the stable path's event name is logged: never the
 * request body, query or cookies.
 */
const LIFECYCLE_EVENTS: Readonly<Record<string, EventName>> = {
  '/passkey/verify-registration': 'auth.passkey.enrolled',
  '/passkey/verify-authentication': 'auth.passkey.authenticated',
  '/passkey/delete-passkey': 'auth.passkey.removed',
  '/revoke-session': 'auth.session.revoked',
  '/revoke-sessions': 'auth.session.revoked_all',
  '/revoke-other-sessions': 'auth.session.revoked_all',
  '/change-email': 'auth.email_change.requested',
};

/**
 * The one emitter for those milestones, called after a successful call to
 * the Better Auth path, whichever route reached it: the mounted
 * `/api/auth` handler, or a Offense Demo route calling `auth.api` (single-session
 * revoke from the account UI). The caller's request-scoped logger keeps the
 * request correlation.
 */
export function logAuthLifecycle(logger: Logger, betterAuthPath: string) {
  const event = LIFECYCLE_EVENTS[betterAuthPath];
  if (!event) return;
  logger.log(event, { operation: 'auth.request' }, event.replace(/\./g, ' '));
}
