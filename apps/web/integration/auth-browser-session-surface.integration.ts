import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createPasskeyFlows } from './auth-passkey-flows';
import { cookieHeader } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();

/**
 * ISSUE-63 (ISSUE-5 AC7): no response the browser can reach from the mounted
 * `/api/auth/*` handler carries a session token or a client IP address. Every
 * request here goes through the real mounted route, exactly as the browser
 * client's `getSession()` and `signIn.passkey()` send it.
 */
const flows = await createPasskeyFlows();
const { signUp } = flows.account;

/** Every key named anywhere in a JSON body, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
      : [];

/** Whether a JSON body names either key at any depth; a non-JSON body by text. */
const leaks = async (response: Response) => {
  const body = await response.clone().text();
  let keys: string[];
  try {
    keys = keysOf(JSON.parse(body));
  } catch {
    keys = ['token', 'ipAddress'].filter((key) => body.includes(key));
  }
  return {
    token: keys.includes('token'),
    ipAddress: keys.includes('ipAddress'),
  };
};

describe('ISSUE-63 the browser never receives a session token or client IP', () => {
  test('GET /api/auth/get-session, as SessionRefresh calls it', async () => {
    const { cookie } = await signUp();
    const response = await flows.get('/api/auth/get-session', cookie);
    const body = (await response.clone().json()) as {
      session?: { id?: string; expiresAt?: string };
      user?: { id?: string };
    } | null;
    assert({
      given: 'a signed-in browser reading its own session',
      should:
        'answer the session and user the client needs, with no token or ipAddress at any depth',
      actual: {
        status: response.status,
        hasSession: typeof body?.session?.id === 'string',
        hasExpiry: typeof body?.session?.expiresAt === 'string',
        hasUser: typeof body?.user?.id === 'string',
        leaks: await leaks(response),
      },
      expected: {
        status: 200,
        hasSession: true,
        hasExpiry: true,
        hasUser: true,
        leaks: { token: false, ipAddress: false },
      },
    });
  });

  test('GET /api/auth/list-sessions is not mounted', async () => {
    const { cookie } = await signUp();
    const response = await flows.get('/api/auth/list-sessions', cookie);
    assert({
      given: 'a signed-in browser asking Better Auth to list its sessions',
      should:
        "answer 404 (the account UI lists through Offense Demo's own route), leaking nothing",
      actual: { status: response.status, leaks: await leaks(response) },
      expected: { status: 404, leaks: { token: false, ipAddress: false } },
    });
  });

  test('POST /api/auth/passkey/verify-authentication, as signIn.passkey() calls it', async () => {
    const { cookie } = await signUp();
    const { credential } = await flows.enrollPasskey(cookie, {
      name: 'Surface key',
    });
    const { verifyResponse } = await flows.signInWithPasskey(credential);
    const signedIn = cookieHeader(verifyResponse);
    const session = await flows.get('/api/auth/get-session', signedIn);
    assert({
      given: 'a real passkey sign-in',
      should:
        'set a working session cookie and answer with no token or ipAddress at any depth',
      actual: {
        status: verifyResponse.status,
        leaks: await leaks(verifyResponse),
        cookieWorks: (await session.json()) !== null,
      },
      expected: {
        status: 200,
        leaks: { token: false, ipAddress: false },
        cookieWorks: true,
      },
    });
  });

  test('POST /api/auth/passkey/verify-registration with createSession', async () => {
    const { cookie } = await signUp();
    const { verifyResponse } = await flows.enrollPasskey(cookie, {
      name: 'Session-creating key',
      createSession: true,
    });
    assert({
      given: 'a registration whose body asks for a new session',
      should: 'answer with no token or ipAddress at any depth',
      actual: {
        status: verifyResponse.status,
        leaks: await leaks(verifyResponse),
      },
      expected: { status: 200, leaks: { token: false, ipAddress: false } },
    });
  });

  test('server-side reads still carry the token Offense Demo needs', async () => {
    const { cookie } = await signUp();
    const [own] = await flows.listSessions(cookie);
    const current = await flows.serverSession(cookie);
    assert({
      given: 'the same account read through auth.api on the server',
      should:
        "keep the token for server use (revoke by id), matching the caller's own session",
      actual: {
        listed: typeof own?.token === 'string' && own.token.length > 0,
        same: own?.token === current?.session.token,
      },
      expected: { listed: true, same: true },
    });
  });
});
