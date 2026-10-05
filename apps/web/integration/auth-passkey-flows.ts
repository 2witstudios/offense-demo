import { createAccountFlows } from './auth-account-helpers';
import { createId } from '@paralleldrive/cuid2';
import { cookieHeader, linkFrom, origin, tokenOf } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createSoftwareCredential,
  type SoftwareCredential,
} from './webauthn-authenticator';

export const rpID = 'localhost';

const mergeCookies = (...parts: readonly string[]): string =>
  parts.filter((part) => part !== '').join('; ');

/**
 * Passkey ceremony harness: drives the REAL `/api/auth/passkey/*` endpoints
 * (mounted exactly as production does, via `createAccountFlows`'s
 * `authRoute`) with a software authenticator standing in for the browser's
 * `navigator.credentials`. Only the physical device is out of scope; the
 * WebAuthn verification code under test is the real
 * `@simplewebauthn/server` calls the passkey plugin makes.
 */
export async function createPasskeyFlows() {
  const account = createAccountFlows();
  const { authRoute, newClient } = account.flows;

  const get = (path: string, cookie?: string) =>
    authRoute.GET(
      new Request(`${origin}${path}`, {
        headers: {
          ...(cookie ? { cookie } : {}),
          [CLIENT_IP_HEADER]: newClient(),
          origin,
        },
      }),
    );
  const post = (
    path: string,
    body: unknown,
    cookie?: string,
    extraOrigin?: string,
  ) =>
    authRoute.POST(
      new Request(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: extraOrigin ?? origin,
          ...(cookie ? { cookie } : {}),
          [CLIENT_IP_HEADER]: newClient(),
        },
        body: JSON.stringify(body),
      }),
    );

  /** Registers a new passkey for the cookie's account; returns the credential. */
  const enrollPasskey = async (
    cookie: string,
    options: {
      readonly name?: string;
      readonly badOrigin?: string;
      readonly badRpID?: string;
      readonly badChallenge?: string;
      readonly createSession?: boolean;
    } = {},
  ) => {
    const optionsResponse = await get(
      '/api/auth/passkey/generate-register-options',
      cookie,
    );
    const registrationOptions = (await optionsResponse.json()) as {
      challenge: string;
    };
    const credential = await createSoftwareCredential();
    const registrationResponse = buildRegistrationResponse({
      credential,
      challenge: options.badChallenge ?? registrationOptions.challenge,
      origin: options.badOrigin ?? origin,
      rpID: options.badRpID ?? rpID,
    });
    const verifyResponse = await post(
      '/api/auth/passkey/verify-registration',
      {
        response: registrationResponse,
        name: options.name,
        ...(options.createSession ? { createSession: true } : {}),
      },
      mergeCookies(cookie, cookieHeader(optionsResponse)),
    );
    return { optionsResponse, verifyResponse, credential };
  };

  /** Authenticates with an already-enrolled credential; returns the response. */
  const signInWithPasskey = async (
    credential: SoftwareCredential,
    options: { readonly badOrigin?: string; readonly badRpID?: string } = {},
  ) => {
    const optionsResponse = await get(
      '/api/auth/passkey/generate-authenticate-options',
    );
    const authenticationOptions = (await optionsResponse.json()) as {
      challenge: string;
    };
    const assertion = await buildAuthenticationResponse({
      credential,
      challenge: authenticationOptions.challenge,
      origin: options.badOrigin ?? origin,
      rpID: options.badRpID ?? rpID,
    });
    const verifyResponse = await post(
      '/api/auth/passkey/verify-authentication',
      { response: assertion },
      // A cookie header carries a signed challenge cookie set by the
      // options call above; the options response's Set-Cookie must ride
      // along for the verify call to find its own challenge.
      cookieHeader(optionsResponse),
    );
    return { optionsResponse, verifyResponse, assertion };
  };

  const listPasskeys = (cookie: string) =>
    get('/api/auth/passkey/list-user-passkeys', cookie);
  const deletePasskey = (cookie: string, id: string) =>
    post('/api/auth/passkey/delete-passkey', { id }, cookie);
  const renamePasskey = (cookie: string, id: string, name: string) =>
    post('/api/auth/passkey/update-passkey', { id, name }, cookie);

  // The mounted /list-sessions is disabled and browser responses carry no
  // token (ISSUE-63), so suites that need a session token read it the way
  // Offense Demo's own server code does: through auth.api, with no Request.
  const serverApi = () => account.flows.app.auth().instance.api;
  const listSessions = async (cookie: string) =>
    (await serverApi().listSessions({
      headers: new Headers({ cookie }),
    })) as readonly { readonly token: string; readonly userId: string }[];
  const serverSession = (cookie: string) =>
    serverApi().getSession({
      headers: new Headers({ cookie }),
      query: { disableRefresh: true },
    });
  const revokeSession = (cookie: string, token: string) =>
    post('/api/auth/revoke-session', { token }, cookie);
  const revokeOtherSessions = (cookie: string) =>
    post('/api/auth/revoke-other-sessions', {}, cookie);
  const revokeSessions = (cookie: string) =>
    post('/api/auth/revoke-sessions', {}, cookie);

  const changeEmail = (cookie: string, newEmail: string) =>
    post('/api/auth/change-email', { newEmail }, cookie);

  const confirmEmailRoute = account.flows.testApp.routes.confirmEmail;
  /** Follows an email-change link to the confirm page as a browser does. */
  const confirmEmailGet = (link: URL) =>
    confirmEmailRoute.GET(
      new Request(link, { headers: { [CLIENT_IP_HEADER]: newClient() } }),
    );
  /** Submits the confirm page's form for an email-change token. */
  const confirmEmailPost = (token: string) =>
    confirmEmailRoute.POST(
      new Request(`${origin}/auth/confirm-email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin,
          [CLIENT_IP_HEADER]: newClient(),
        },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
  /**
   * Requests a change of the cookie's account to a fresh address and
   * confirms the first hop through the confirm page, returning the new
   * address and the second-hop verification token it mailed.
   */
  const confirmedEmailChange = async (cookie: string) => {
    const { mails } = account.flows.mailbox;
    const before = mails.length;
    const newEmail = `${createId()}@example.test`;
    await changeEmail(cookie, newEmail);
    await confirmEmailPost(tokenOf(linkFrom(mails[before]!)));
    return { newEmail, verifyToken: tokenOf(linkFrom(mails[before + 1]!)) };
  };
  /** The event names this suite's app logged while `work` ran (AUTH-6.4). */
  const recordedEvents = async (work: () => Promise<void>) => [
    ...(await account.flows.testApp.withLoggedEvents(work)).events,
  ];
  const isAuthenticated = async (cookie: string): Promise<boolean> =>
    (await (
      await get('/api/auth/get-session?disableCookieCache=true', cookie)
    ).json()) !== null;

  return {
    account,
    authRoute,
    get,
    post,
    enrollPasskey,
    signInWithPasskey,
    listPasskeys,
    deletePasskey,
    renamePasskey,
    listSessions,
    serverSession,
    revokeSession,
    revokeOtherSessions,
    revokeSessions,
    changeEmail,
    confirmEmailGet,
    confirmEmailPost,
    confirmedEmailChange,
    isAuthenticated,
    recordedEvents,
  };
}
