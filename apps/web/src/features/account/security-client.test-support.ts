import type { SecurityClient, Send } from './security-client';

export const noop = async () => ({ data: null, error: null });

export const clientWith = (
  overrides: Partial<SecurityClient>,
): SecurityClient => ({
  passkey: {
    listUserPasskeys: async () => ({ data: [], error: null }),
    updatePasskey: noop,
    deletePasskey: noop,
  },
  revokeOtherSessions: noop,
  signOut: noop,
  ...overrides,
});

/** Runs `run` with a stub `fetch` answering every call with `respond`. */
export const withFetch = <T>(
  respond: (input: string, init?: RequestInit) => Response,
  run: (send: Send) => Promise<T>,
): Promise<T> => run(async (input, init) => respond(input, init));

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
