import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { systemClock, systemId } from '@offense-demo/clock';
import { createDatabase } from '@offense-demo/db';
import { createTestApp, fixtureEmail } from './fixtures';
import { createAuthRouteHandlers } from '../src/features/auth/handlers';
import { createConfirmHandlers } from '../src/features/auth/confirm';
import { createAuthServer } from '../src/features/auth/server';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
const testApp = createTestApp();
const { jsonPost, formPost } = testApp;

const silent = { log: () => {}, child: () => silent };
/** An auth server whose PostgreSQL is unreachable: persistence must fail. */
const unreachableDatabase = () => {
  const database = createDatabase({
    url: 'postgres://offense_demo:unused-password@127.0.0.1:1/offense_demo_test',
  });
  const sent: string[] = [];
  const server = createAuthServer({
    config: testApp.app.auth().config,
    database: database.authAdapter,
    emailSender: {
      send: async (message) => {
        sent.push(message.to);
      },
    },
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    ledger: { isSuppressed: async () => false, record: async () => {} },
    appendSessionRevoked: async () => {},
    revokeOtherSessions: async () => 0,
    completeEmailChange: (input) => database.completeEmailChange(input),
    revokeSessionUnlessAddressHeld: (input) =>
      database.revokeSessionUnlessAddressHeld(input),
    logger: silent,
    clock: systemClock,
    ids: systemId,
  });
  const auth = () => ({
    handler: server.instance.handler,
    config: server.config,
  });
  return { sent, auth };
};

/* eslint-disable no-console -- this test proves what the framework prints */
/** Everything the console prints while `work` runs. */
async function captureConsole(work: () => Promise<void>) {
  const lines: string[] = [];
  const originals = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  const push = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  console.error = push;
  console.warn = push;
  console.log = push;
  try {
    await work();
  } finally {
    Object.assign(console, originals);
  }
  return lines.join('\n');
}

/* eslint-enable no-console */

describe('AUTH-3.3 token persistence failure', () => {
  test('a database outage while issuing a link is a safe retryable 503 that prints no SQL, parameters or address', async () => {
    const { auth, sent } = unreachableDatabase();
    const email = fixtureEmail();
    let response: Response | undefined;
    const printed = await captureConsole(async () => {
      response = await createAuthRouteHandlers(auth, silent).POST(
        jsonPost('/api/auth/sign-in/magic-link', { email }),
      );
    });
    const body = await response?.text();
    assert({
      given: 'PostgreSQL unreachable when the verification token is persisted',
      should:
        'answer a fixed retryable 503 and neither respond with nor print SQL, bound parameters or the address',
      actual: {
        status: response?.status,
        retryAfter: response?.headers.get('retry-after'),
        code: (JSON.parse(body ?? '{}') as { error?: { code?: string } }).error
          ?.code,
        bodyLeaks: ['insert into', 'verification', email, 'password'].filter(
          (needle) => body?.includes(needle),
        ),
        printedLeaks: [
          'insert into',
          'params',
          email,
          'unused-password',
        ].filter((needle) => printed.includes(needle)),
        sent: sent.length,
      },
      expected: {
        status: 503,
        retryAfter: '5',
        code: 'INFRASTRUCTURE',
        bodyLeaks: [],
        printedLeaks: [],
        sent: 0,
      },
    });
  });

  test('a database outage while redeeming keeps the person on a retryable confirmation page without exposing the token in a URL', async () => {
    const { auth } = unreachableDatabase();
    const token = 'abcdefghijklmnopqrstuvwxyzABCDEF';
    const response = await createConfirmHandlers({ auth, logger: silent }).POST(
      formPost({ token, callbackURL: '/app' }),
    );
    const html = await response.text();
    assert({
      given: 'PostgreSQL unreachable when a token is redeemed',
      should:
        'render a 503 retry view (token only in the POST form), set no cookie and never redirect',
      actual: {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        cookies: response.headers.getSetCookie().length,
        location: response.headers.get('location'),
        retryForm: html.includes(`name="token" value="${token}"`),
        alert: html.includes('role="alert"'),
        sqlLeak: /insert into|params/.test(html),
      },
      expected: {
        status: 503,
        retryAfter: '5',
        cookies: 0,
        location: null,
        retryForm: true,
        alert: true,
        sqlLeak: false,
      },
    });
  });
});
