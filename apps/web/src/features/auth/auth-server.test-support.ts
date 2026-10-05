import { memoryAdapter } from '@better-auth/memory-adapter';
import { fixedClock, sequentialId } from '@offense-demo/clock';
import { readAuthConfig } from '@offense-demo/config';
import { silentLogger } from '../../server/test-loggers.test-support';
import type { CompleteEmailChange } from './email-change';
import type { RevokeSessionUnlessAddressHeld } from './sign-in-address-guard';
import { createAuthServer, type AuthEmailMessage } from './server';

/**
 * Shared fixtures for the auth suites: one env (the integration apps are
 * built from it too), one composed server.
 */

export const authTestEnv = {
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET:
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  RECIPIENT_HASH_SECRET:
    'b8a6a86e17fc0067bd98c85480bf6e6ee0d50b18dc11bd5dc6240453c40e8031',
  PUBLIC_APP_URL: 'http://localhost:3000',
  RESEND_API_KEY: 're_test_000000000000000000000000',
  AUTH_EMAIL_FROM: 'Offense Demo <no-reply@offense-demo.example.com>',
};

/** Fresh in-memory Better Auth tables a test can inspect after the fact. */
export const memoryTables = () => ({
  user: [] as Array<Record<string, unknown>>,
  session: [] as Array<Record<string, unknown>>,
  account: [] as Array<Record<string, unknown>>,
  verification: [] as Array<Record<string, unknown>>,
  passkey: [] as Array<Record<string, unknown>>,
});

/**
 * `@offense-demo/db`'s `completeEmailChange` contract over in-memory tables, for
 * the unit suites; the real transaction is proven against PostgreSQL in
 * `integration/auth-email-change-old-address-links.integration.ts`.
 */
const memoryEmailChange =
  (tables: ReturnType<typeof memoryTables>): CompleteEmailChange =>
  async ({ userId, email, newEmail, signInPurpose }) => {
    const user = tables.user.find(
      (row) => row.id === userId && row.email === email,
    );
    if (!user || tables.user.some((row) => row.email === newEmail))
      return 'stale';
    Object.assign(user, { email: newEmail, emailVerified: true });
    const revoked = tables.verification.filter(
      (row) =>
        String(row.identifier).startsWith(`${signInPurpose}:`) &&
        String(JSON.parse(String(row.value)).email).toLowerCase() ===
          email.toLowerCase(),
    );
    for (const row of revoked)
      tables.verification.splice(tables.verification.indexOf(row), 1);
    return 'changed';
  };

/**
 * `@offense-demo/db`'s `revokeSessionUnlessAddressHeld` contract over in-memory
 * tables; the real statement's race is proven against PostgreSQL in
 * `integration/auth-email-change-old-address-links.integration.ts`.
 */
const memorySessionGuard =
  (tables: ReturnType<typeof memoryTables>): RevokeSessionUnlessAddressHeld =>
  async ({ token, email }) => {
    const session = tables.session.find((row) => row.token === token);
    if (
      !session ||
      tables.user.some(
        (row) => row.id === session.userId && row.email === email,
      )
    )
      return false;
    tables.session.splice(tables.session.indexOf(session), 1);
    return true;
  };

/** A mail seam that keeps every message it was asked to send. */
export function capturingSender() {
  const sent: AuthEmailMessage[] = [];
  return {
    sent,
    send: async (input: AuthEmailMessage) => {
      sent.push(input);
    },
  };
}

/**
 * The auth server composed over in-memory tables, a fixed clock and
 * sequential ids, with an allowing limiter and no-op seams; a test overrides
 * only the seams it exercises.
 */
export const composeAuthServer = (
  overrides: Partial<Parameters<typeof createAuthServer>[0]> = {},
  tables = memoryTables(),
) =>
  createAuthServer({
    config: readAuthConfig(authTestEnv),
    database: memoryAdapter(tables),
    completeEmailChange: memoryEmailChange(tables),
    revokeSessionUnlessAddressHeld: memorySessionGuard(tables),
    emailSender: capturingSender(),
    limiter: { consume: async () => ({ allowed: true, retryAfterSeconds: 0 }) },
    logger: silentLogger,
    clock: fixedClock('2026-09-20T00:00:00.000Z'),
    ids: sequentialId('auth'),
    appendSessionRevoked: async () => {},
    revokeOtherSessions: async () => 0,
    ...overrides,
  });

/** Requests a magic link through the API: 'OK' or the refusal's status. */
export const requestLinkStatus = async (
  server: ReturnType<typeof createAuthServer>,
  email: string,
  headers?: HeadersInit,
) => {
  try {
    await server.instance.api.signInMagicLink({
      body: { email },
      headers: new Headers({ origin: authTestEnv.PUBLIC_APP_URL, ...headers }),
    });
    return 'OK';
  } catch (error) {
    return String((error as { status?: unknown }).status);
  }
};
