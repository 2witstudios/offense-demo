import { getSessionCookie } from 'better-auth/cookies';

/**
 * Whether a request carries a Better Auth session cookie at all, by Better
 * Auth's own naming rules (prefix, `__Secure-` variant). Presence only: it
 * says nothing about whether the session is live, which only the durable
 * session read decides.
 */
export const hasSessionCookie = (headers: Headers): boolean =>
  getSessionCookie(headers) !== null;
