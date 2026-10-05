import type { ClientError } from '../auth/client-error';
import { outcomeFor, type SecurityOutcome } from './security-client';

/** Better Auth's error body: `{ code, message }` at the top level. */
const betterAuthError = async (response: Response): Promise<ClientError> => {
  const body = (await response.json().catch(() => ({}))) as {
    readonly code?: unknown;
  };
  return {
    status: response.status,
    code: typeof body.code === 'string' ? body.code : undefined,
  };
};

/**
 * Starts an email change over POST /api/auth/change-email: the address on
 * file is asked to approve it, and nothing changes until it does. `send` is
 * the email-change form action's in-process transport.
 */
export const requestEmailChange = async (
  newEmail: string,
  send: (url: string, init: RequestInit) => Promise<Response>,
): Promise<SecurityOutcome> => {
  let response: Response;
  try {
    response = await send('/api/auth/change-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newEmail }),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  return outcomeFor(response.ok ? null : await betterAuthError(response));
};
