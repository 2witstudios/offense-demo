import {
  cookieHeader,
  createTestApp,
  type TestApp,
  linkFrom,
  tokenOf,
  withSql,
} from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';

/**
 * Mounted-route flow harness: the REAL `/api/auth` and `/auth/confirm` route
 * handlers of this suite's own app over real PostgreSQL/Redis with only the
 * mail transport captured.
 * Its app removes the accounts it created after the suite.
 */
export function createFlows(testApp: TestApp = createTestApp()) {
  const {
    routes,
    mailbox,
    jsonPost,
    formPost,
    newClient,
    freshEmail: fresh,
    recordAccountIds,
  } = testApp;
  const authRoute = routes.auth;
  const confirmRoute = routes.confirm;
  const requestLink = async (
    email: string,
    body: Record<string, unknown> = {},
  ) => {
    const before = mailbox.mails.length;
    const response = await authRoute.POST(
      jsonPost('/api/auth/sign-in/magic-link', { email, ...body }),
    );
    const mail = mailbox.mails[before];
    return { response, mail, link: mail ? linkFrom(mail) : undefined };
  };
  /**
   * The link a request that must succeed mailed. One that mailed nothing
   * fails with the answer it got instead, so a refusal or an outage names
   * itself rather than surfacing as a TypeError in `tokenOf` (ISSUE-98).
   */
  const mailedLink = async ({
    response,
    link,
  }: Awaited<ReturnType<typeof requestLink>>) => {
    if (link) return link;
    const { code } = (await response.json().catch(() => ({}))) as {
      code?: unknown;
    };
    throw new Error(
      `The link request mailed nothing: HTTP ${response.status}, code ${String(code)}`,
    );
  };
  /** A fresh magic-link token for an address, as its mail carries it. */
  const linkTokenFor = async (email: string) =>
    tokenOf(await mailedLink(await requestLink(email)));
  /** A second real session for an address: a new link, redeemed. */
  const signInAgain = async (email: string) =>
    cookieHeader(await redeem(await linkTokenFor(email)));
  const confirmGet = (link: URL, method: 'GET' | 'HEAD' = 'GET') =>
    confirmRoute[method](
      new Request(link, {
        method,
        headers: { [CLIENT_IP_HEADER]: newClient() },
      }),
    );
  /** Redeems a link; a new account is then keyed by its user id too. */
  const redeem = async (token: string, extra: Record<string, string> = {}) => {
    const response = await confirmRoute.POST(
      formPost({ token, callbackURL: '/app', ...extra }),
    );
    // Only a redemption that set a session can have created a user.
    if (response.headers.getSetCookie().length > 0) await recordAccountIds();
    return response;
  };
  /** A new address with a requested link and its token. */
  const startSignup = async () => {
    const email = fresh();
    const requested = await requestLink(email);
    const link = await mailedLink(requested);
    return { email, ...requested, link, token: tokenOf(link) };
  };
  const session = (response: Response) =>
    authRoute.GET(
      new Request(`${testApp.origin}/api/auth/get-session`, {
        headers: {
          cookie: cookieHeader(response),
          [CLIENT_IP_HEADER]: newClient(),
        },
      }),
    );
  return {
    testApp,
    app: testApp.app,
    mailbox,
    authRoute,
    confirmRoute,
    newClient,
    jsonPost,
    formPost,
    fresh,
    requestLink,
    linkTokenFor,
    signInAgain,
    confirmGet,
    redeem,
    startSignup,
    session,
    userRows: (email: string) =>
      withSql(
        (sql) =>
          sql`SELECT id, email, email_verified FROM users WHERE email = ${email}`,
      ),
  };
}
