/**
 * Durable session timing, shared by the Better Auth composition and the
 * server's refresh decision so the two can never disagree.
 */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;
export const SESSION_FRESH_AGE_SECONDS = 60 * 60;

/**
 * Better Auth slides a session once `updateAge` has passed since it was
 * last extended (1.7.5 `get-session`: expiresAt - expiresIn + updateAge <=
 * now). Both instants are UTC ISO strings.
 */
export const sessionRefreshDue = (expiresAt: string, now: string): boolean =>
  Date.parse(expiresAt) -
    SESSION_EXPIRES_IN_SECONDS * 1000 +
    SESSION_UPDATE_AGE_SECONDS * 1000 <=
  Date.parse(now);
