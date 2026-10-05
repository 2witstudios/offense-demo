import { createId } from '@paralleldrive/cuid2';
import type { Identity } from '@offense-demo/auth';
import { createFlows } from './auth-mounted-flows';
import { cookieHeader, withSql, type TestApp } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { CONFIRM_PATH } from '../src/features/auth/confirm-page';
import { identify, resolveSession } from '../src/lib/identity';

/**
 * A replayed, invalid or otherwise redeemed emailed-link token maps to a
 * 303 back to the confirm page with `?error=INVALID_TOKEN` and no cookie,
 * never the success redirect (`confirm.ts`).
 */
export const emailedLinkRejected = (response: Response): boolean => {
  const location = response.headers.get('location') ?? '';
  return (
    response.status === 303 &&
    location.startsWith(CONFIRM_PATH) &&
    location.includes('error=INVALID_TOKEN') &&
    response.headers.getSetCookie().length === 0
  );
};

/**
 * Account harness for the stage-4 suites: real sign-up through the mounted
 * request and /auth/confirm routes, and the real username claim route, all
 * on the suite's own app.
 */
export function createAccountFlows(testApp?: TestApp) {
  const flows = createFlows(testApp);
  const { app, jsonPost, newClient } = flows;
  /** A server-side session read as a page render makes it for one client. */
  const identifyAs = (cookie: string, client = newClient()) =>
    identify(app.auth(), new Headers({ cookie, [CLIENT_IP_HEADER]: client }));
  const usernameRoute = flows.testApp.routes.username;

  /** A brand-new account signed in through the real request → confirm path. */
  const signUp = async () => {
    const { email, token } = await flows.startSignup();
    const response = await flows.redeem(token, {
      newUserCallbackURL: '/onboarding/username?next=%2Fapp',
    });
    return { email, token, response, cookie: cookieHeader(response) };
  };

  const claim = (
    cookie: string | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    usernameRoute.POST(
      jsonPost('/api/account/username', body, {
        ...(cookie ? { cookie } : {}),
        ...headers,
      }),
    );

  const sessionAs = (cookie: string) =>
    resolveSession(
      app.auth(),
      new Headers({ cookie, [CLIENT_IP_HEADER]: newClient() }),
    );

  return { flows, identifyAs, sessionAs, signUp, claim };
}

/** The user id behind a signed-in identity, or null for anyone else. */
export const identityUserId = (identity: Identity): string | null =>
  identity.state === 'member' || identity.state === 'provisional'
    ? identity.principal.userId
    : null;

export const uniqueName = () => `u${createId().slice(0, 14)}`;

export const usernameOf = (email: string) =>
  withSql(
    async (sql) =>
      (
        (await sql`SELECT username FROM users WHERE email = ${email}`)[0] as
          { username: string | null } | undefined
      )?.username ?? null,
  );
