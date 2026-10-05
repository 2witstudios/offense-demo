'use client';

import { useEffect } from 'react';
import { authClient } from '../../../lib/auth-client';

/**
 * Keeps a durable session sliding. Server components read sessions without
 * refreshing (they cannot set cookies), so when the server sees a refresh
 * is due (lib/request-session.ts) it renders this, and the browser asks the
 * real `/api/auth/get-session` handler, which extends the session row and
 * its cookie together. It shows nothing.
 */
export function SessionRefresh() {
  useEffect(() => {
    void authClient.getSession();
  }, []);
  return null;
}
