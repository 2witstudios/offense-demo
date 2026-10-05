import { readAuthConfig } from '@offense-demo/config';
import { createDatabase } from '@offense-demo/db';
import { fixedClock, systemId } from '@offense-demo/clock';
import type { Logger } from '@offense-demo/logger';
import { createConfirmHandlers } from '../src/features/auth/confirm';
import type { RecordedLogs } from '../src/features/auth/log-leaks';
import {
  createAuthServer,
  type AuthEmailMessage,
} from '../src/features/auth/server';
import type { CompleteEmailChange } from '../src/features/auth/email-change';
import type { RevokeSessions } from '../src/features/auth/revoke-sessions';
import type { RevokeSessionUnlessAddressHeld } from '../src/features/auth/sign-in-address-guard';
import { silentLogger } from '../src/server/test-loggers.test-support';
import { authTestEnv } from '../src/features/auth/auth-server.test-support';

/**
 * A Better Auth server over a given database adapter, built from the
 * shared `authTestEnv`, for the suites that exercise the persistence seams
 * directly rather than the mounted routes.
 */

// Child loggers record into the same sink, so nothing logged is hidden.
const recordingLogger = (recordedLogs: RecordedLogs | undefined): Logger => ({
  log: (...entry) => {
    recordedLogs?.push(entry);
  },
  child: () => recordingLogger(recordedLogs),
});

export type SentMessages = AuthEmailMessage[];

/**
 * A Better Auth server over a given database adapter, for the suites that
 * exercise the persistence seams directly rather than the mounted routes.
 */
export const createTestAuthServer = (
  database: Parameters<typeof createAuthServer>[0]['database'],
  options: {
    readonly sent: SentMessages;
    readonly deliveryFailure?: Error;
    readonly recordedLogs?: RecordedLogs;
    /** Defaults to a no-op; a suite proving RT-2.2's outbox append wires the real one. */
    readonly appendSessionRevoked?: (userId: string) => Promise<void>;
    /** Defaults to a no-op; a suite proving ISSUE-3 AC3 wires the real one. */
    readonly revokeOtherSessions?: RevokeSessions;
    /** Defaults to refusing; a suite completing an email change wires the real one. */
    readonly completeEmailChange?: CompleteEmailChange;
    /** Defaults to keeping every session; a suite over PostgreSQL wires the real one. */
    readonly revokeSessionUnlessAddressHeld?: RevokeSessionUnlessAddressHeld;
  },
) =>
  createAuthServer({
    config: readAuthConfig(authTestEnv),
    database,
    emailSender: {
      send: async (message) => {
        if (options.deliveryFailure) throw options.deliveryFailure;
        options.sent.push(message);
      },
    },
    limiter: {
      consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    },
    logger: recordingLogger(options.recordedLogs),
    clock: fixedClock('2026-09-20T00:00:00.000Z'),
    // The composition mints entity ids from this injection; the durable
    // suites share one database, so they need the real cuid2 edge generator.
    ids: systemId,
    appendSessionRevoked: options.appendSessionRevoked ?? (async () => {}),
    revokeOtherSessions: options.revokeOtherSessions ?? (async () => 0),
    completeEmailChange:
      options.completeEmailChange ?? (async () => 'stale' as const),
    revokeSessionUnlessAddressHeld:
      options.revokeSessionUnlessAddressHeld ?? (async () => false),
  });

/**
 * Redeems a magic-link token the way a person does: POST to the same-origin
 * confirm page, which forwards into Better Auth internally
 * (`confirm-http-shared.ts`'s `createForward` calls `server.handler`
 * directly, never through the mounted `/api/auth` route). A direct GET to
 * `/api/auth/magic-link/verify` is refused by the mounted route (ISSUE-3),
 * so tests must never build that URL and hit it themselves.
 */
export const redeemMagicLink = (
  auth: ReturnType<typeof createTestAuthServer>,
  token: string,
) =>
  createConfirmHandlers({
    auth: () => ({ handler: auth.instance.handler, config: auth.config }),
    logger: silentLogger,
  }).POST(
    new Request(`${auth.config.PUBLIC_APP_URL}/auth/confirm`, {
      method: 'POST',
      headers: {
        origin: auth.config.PUBLIC_APP_URL,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token, callbackURL: '/' }).toString(),
    }),
  );

/**
 * A database pool over the test services and a direct auth server on its
 * adapter, recording the mail it sends and the logs it writes. `wire`
 * connects seams that need the database (the outbox append, say).
 */
export const createDatabaseAuthServer = (
  url: string,
  wire: (
    database: ReturnType<typeof createDatabase>,
  ) => Partial<Parameters<typeof createTestAuthServer>[1]> = () => ({}),
) => {
  const sent: SentMessages = [];
  const logged: RecordedLogs = [];
  const database = createDatabase({ url });
  const auth = createTestAuthServer(database.authAdapter, {
    sent,
    recordedLogs: logged,
    revokeOtherSessions: (userId, keepToken) =>
      database.revokeOtherSessions(userId, keepToken),
    completeEmailChange: (input) => database.completeEmailChange(input),
    revokeSessionUnlessAddressHeld: (input) =>
      database.revokeSessionUnlessAddressHeld(input),
    ...wire(database),
  });
  return { sent, logged, database, auth };
};
