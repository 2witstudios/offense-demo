import { cache } from 'react';
import { headers } from 'next/headers';
import type { Identity } from '@offense-demo/auth';
import { sessionRefreshDue } from '../features/auth/session-policy';
import { processApp } from '../server/process-app';
import { resolveSession } from './identity';

/**
 * This request's session, resolved once: the root layout and the page it
 * wraps render in the same request, and React's per-request cache makes
 * them share one durable session read.
 */
const requestSession = cache(async () =>
  resolveSession(processApp().auth(), await headers()),
);

/** Who is asking in this server-component render. */
export const requestIdentity = async (): Promise<Identity> =>
  (await requestSession()).identity;

/**
 * Whether the browser should slide this request's session now: only for a
 * live signed-in session past `updateAge`, so a signed-in browser calls the
 * rate-limited `get-session` endpoint about once a day, not per page load.
 */
export const sessionRefreshDueNow = async (): Promise<boolean> => {
  const { sessionExpiresAt } = await requestSession();
  return (
    sessionExpiresAt !== null &&
    sessionRefreshDue(sessionExpiresAt, processApp().clock.now())
  );
};
