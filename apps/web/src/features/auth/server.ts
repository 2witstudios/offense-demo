import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { createAppError } from '@offense-demo/errors';
import type { Clock, IdGenerator } from '@offense-demo/clock';
import type { Logger } from '@offense-demo/logger';
import type { AuthConfig } from '@offense-demo/config';
import type { AuthEmailSender, AuthDeliveryLedger } from './mail-types';
import {
  emailedLinkIdentifier,
  generateEmailedLinkToken,
} from './emailed-link-token';
import { emailChangePlugin, type CompleteEmailChange } from './email-change';
import { createMagicLinkGatePlugin } from './magic-link-gate';
import { createSuppressionCheck } from './suppression-check';
import { freshSessionGatePlugin } from './fresh-session-gate';
import { browserSessionShapePlugin } from './browser-session-shape';
import { passkeyDeviceHintPlugin } from './passkey-device-hint';
import { passkeyNotificationsPlugin } from './passkey-notifications';
import { passkeyOwnershipGuardPlugin } from './passkey-ownership-guard';
import { sessionRevokedOutboxPlugin } from './session-revoked-outbox';
import { revokeOthersOnEmailChangePlugin } from './revoke-others-on-email-change';
import { revokeSessionsPlugin, type RevokeSessions } from './revoke-sessions';
import {
  signInAddressGuardPlugin,
  type RevokeSessionUnlessAddressHeld,
} from './sign-in-address-guard';
import { deriveRecipientSubkey } from './recipient-key';
import { createSendMail } from './send-mail';
import type { Deliver } from './deliver-or-unavailable';
import {
  createAfterResponse,
  type AfterResponseLimits,
} from './after-response';
import { createSendMagicLink } from './sign-in-mail';
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from './session-policy';
import { appConfig } from '../../app-config';
import { CLIENT_IP_HEADER } from './client-ip';
import {
  clientIpOptions,
  createRateLimitGate,
  createSignUpCeiling,
  type AuthRateLimiter,
} from './rate-limit';

const MAGIC_LINK_EXPIRES_IN_SECONDS = 300;

/** Application-level email contract; the Resend transport plugs in here. */
export type {
  AuthEmailMessage,
  AuthEmailSender,
  AuthDeliveryLedger,
} from './mail-types';
/** Composition without a ledger neither suppresses nor records receipts. */
const noLedger: AuthDeliveryLedger = {
  isSuppressed: async () => false,
  record: async () => {},
};

/**
 * The composed Better Auth instance with the passwordless plugins applied.
 * Created lazily by the factory; importing this module performs no I/O.
 */
type AuthInstance = ReturnType<typeof composeBetterAuth>;

const composeBetterAuth = (dependencies: {
  readonly config: AuthConfig;
  readonly recipientSubkey: string;
  readonly database: BetterAuthOptions['database'];
  readonly deliver: Deliver;
  readonly limiter: AuthRateLimiter;
  readonly ledger: AuthDeliveryLedger;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly appendSessionRevoked: (userId: string) => Promise<void>;
  readonly revokeOtherSessions: RevokeSessions;
  readonly completeEmailChange: CompleteEmailChange;
  readonly revokeSessionUnlessAddressHeld: RevokeSessionUnlessAddressHeld;
  readonly afterResponse: ReturnType<typeof createAfterResponse>;
}) => {
  const { config, ledger, recipientSubkey } = dependencies;
  const origin = new URL(config.PUBLIC_APP_URL).origin;
  const checkSuppression = createSuppressionCheck({ recipientSubkey, ledger });
  const magicLinkGatePlugin = createMagicLinkGatePlugin(checkSuppression);
  const instance = betterAuth({
    baseURL: config.PUBLIC_APP_URL,
    trustedOrigins: [origin],
    secret: config.BETTER_AUTH_SECRET,
    database: dependencies.database,
    // Better Auth's default logger prints driver errors verbatim, including
    // SQL text and bound parameters (magic-link tokens, emails). Report only
    // the severity through the application logger.
    logger: {
      log: (level) => {
        if (level === 'error' || level === 'warn')
          dependencies.logger.log(
            'request.unhandled',
            { source: 'better-auth', sourceLevel: level },
            'Authentication library reported a failure',
          );
      },
    },
    // better-call prints unhandled errors with console.error, exposing SQL and
    // parameters; rethrow so the guarded handler below reports them safely.
    onAPIError: { throw: true },
    advanced: {
      database: {
        // Entity identifiers come from the injected generator (cuid2 at
        // the production edge, ADR 0018), never an ambient one.
        generateId: () => dependencies.ids.next(),
      },
      // Trust exactly the one header the ingress stamps; see rate-limit.ts.
      ipAddress: clientIpOptions(CLIENT_IP_HEADER),
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
      // Revocation must be visible on the next server check.
      cookieCache: { enabled: false },
    },
    // The injected atomic limiter is the only rate limit. Better Auth's
    // built-in limiter never sees direct `auth.api` calls and cannot fail
    // closed with a 503, so the gate below replaces it.
    rateLimit: { enabled: false },
    hooks: {
      before: createRateLimitGate({
        limiter: dependencies.limiter,
        logger: dependencies.logger,
        recipientSubkey,
      }),
    },
    emailAndPassword: { enabled: false },
    // Belt and braces: password/reset/delete surfaces answer 404 outright.
    disabledPaths: [
      '/sign-up/email',
      '/sign-in/email',
      '/forget-password',
      '/request-password-reset',
      '/reset-password',
      '/change-password',
      '/set-password',
      '/delete-user',
      '/delete-user/callback',
      // Onboarding is server-owned: the profile has no general update
      // surface, so the username is set only by POST /api/account/username.
      '/update-user',
      // Every row carries its bearer token and client IP; the account UI
      // lists through GET /api/account/sessions, and the server still calls
      // auth.api.listSessions (disabledPaths gates HTTP only).
      '/list-sessions',
      // ISSUE-2: Better Auth's email verification mints signed JWT links;
      // the email change runs on opaque stored tokens (`email-change.ts`).
      '/verify-email',
      '/send-verification-email',
    ],
    user: {
      additionalFields: {
        // Readable on the session; `input: false` refuses any client value.
        username: { type: 'string', required: false, input: false },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        // ISSUE-2: the emailed-link model — an opaque 256-bit CSPRNG token,
        // stored only as its purpose-scoped SHA3-256 digest (Better Auth's
        // `'hashed'` option is SHA-256).
        generateToken: () => generateEmailedLinkToken(),
        storeToken: {
          type: 'custom-hasher',
          hash: async (token) => emailedLinkIdentifier('sign-in', token),
        },
        sendMagicLink: createSendMagicLink({
          origin,
          deliver: dependencies.deliver,
          spendCeiling: createSignUpCeiling({
            limiter: dependencies.limiter,
            logger: dependencies.logger,
          }),
          afterResponse: dependencies.afterResponse.defer,
          dbStep: dependencies.afterResponse.dbStep,
        }),
      }),
      passkey({
        rpID: new URL(config.PUBLIC_APP_URL).hostname,
        rpName: appConfig.brand.displayName,
        origin,
        // Discoverable, so username-less and autofill sign-in can find it;
        // no attachment, so platform and roaming authenticators both enroll.
        // The device-first preference is `passkeyDeviceHintPlugin`'s hint.
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'preferred',
        },
      }),
      passkeyDeviceHintPlugin,
      passkeyOwnershipGuardPlugin,
      passkeyNotificationsPlugin(
        origin,
        dependencies.deliver,
        dependencies.logger,
      ),
      magicLinkGatePlugin,
      signInAddressGuardPlugin(dependencies.revokeSessionUnlessAddressHeld),
      emailChangePlugin({
        origin,
        deliver: dependencies.deliver,
        clock: dependencies.clock,
        completeEmailChange: dependencies.completeEmailChange,
        checkSuppression,
      }),
      freshSessionGatePlugin,
      sessionRevokedOutboxPlugin(
        dependencies.appendSessionRevoked,
        dependencies.logger,
      ),
      revokeOthersOnEmailChangePlugin(
        dependencies.revokeOtherSessions,
        dependencies.logger,
      ),
      revokeSessionsPlugin(dependencies.revokeOtherSessions),
      // Last: strips the session token and ipAddress from every HTTP
      // response after the plugins above have read the full result.
      browserSessionShapePlugin,
    ],
  });
  return {
    ...instance,
    handler: async (request: Request): Promise<Response> => {
      try {
        return await dependencies.afterResponse.around(() =>
          instance.handler(request),
        );
      } catch (error) {
        dependencies.logger.log(
          'request.unhandled',
          { source: 'better-auth' },
          'Authentication request failed',
        );
        // A retryable outage, typed at the source, so callers (the mounted
        // route wrapper, the confirm-page internal forward) read the error
        // code rather than the response.
        throw createAppError('INFRASTRUCTURE', undefined, error);
      }
    },
  };
};

/**
 * Only what production callers read off the result: the app's routes and
 * pages (`server/app.ts` composes it) use `config`, `instance`, `limiter`,
 * `clock` and `logger`, and the app's close waits on `settled`. Mail delivery, `database`, `ledger` and `ids` stay
 * internal to composition; tests reach delivery through a real auth
 * request.
 */
export type AuthServer = {
  readonly config: AuthConfig;
  readonly instance: AuthInstance;
  readonly limiter: AuthRateLimiter;
  readonly logger: Logger;
  readonly clock: Clock;
  /** Resolves once work handed off past an answer has finished (ISSUE-185). */
  readonly settled: () => Promise<void>;
  /** Handed-off work not yet finished (bounded, ISSUE-185). */
  readonly pendingWork: () => number;
};

/**
 * Auth factory: composes the injected, already-validated configuration and
 * dependencies; it performs no I/O and dials no service. Importing
 * this module requires no credentials and contacts nothing.
 */
export function createAuthServer<
  Database extends BetterAuthOptions['database'],
>(dependencies: {
  /** Validated by the composition root (`readAuthConfig`). */
  readonly config: AuthConfig;
  readonly database: Database;
  readonly emailSender: AuthEmailSender;
  readonly limiter: AuthRateLimiter;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Mail receipts and suppressions (production supplies the @offense-demo/db one). */
  readonly ledger?: AuthDeliveryLedger | undefined;
  /** The handed-off work's bounds; the production sizes unless a test narrows them. */
  readonly afterResponseLimits?: AfterResponseLimits | undefined;
  /** RT-2.2: appends `session.revoked` after a confirmed self-service revoke. */
  readonly appendSessionRevoked: (userId: string) => Promise<void>;
  /**
   * ISSUE-22: the one serialized revoke-all (`@offense-demo/db`), behind the email
   * change's revocation and both self-service revoke-all endpoints.
   */
  readonly revokeOtherSessions: RevokeSessions;
  /** ISSUE-99: the email change's address switch and link revocation. */
  readonly completeEmailChange: CompleteEmailChange;
  /**
   * ISSUE-103: removes a just-created magic-link session whose account has
   * moved off the address the link proved.
   */
  readonly revokeSessionUnlessAddressHeld: RevokeSessionUnlessAddressHeld;
}): AuthServer {
  const { config } = dependencies;
  const recipientSubkey = deriveRecipientSubkey(config.RECIPIENT_HASH_SECRET);
  const afterResponse = createAfterResponse(
    dependencies.logger,
    dependencies.afterResponseLimits,
  );
  // Handed-off work's ledger steps go through its database gate; a request
  // being answered is not gated.
  const baseLedger = dependencies.ledger ?? noLedger;
  const ledger: AuthDeliveryLedger = {
    isSuppressed: (hash) =>
      afterResponse.dbStep(() => baseLedger.isSuppressed(hash)),
    record: (input) => afterResponse.dbStep(() => baseLedger.record(input)),
  };
  const sendMail = createSendMail({
    recipientSubkey,
    ledger,
    emailSender: dependencies.emailSender,
    logger: dependencies.logger,
    clock: dependencies.clock,
  });
  return {
    config,
    instance: composeBetterAuth({
      config,
      recipientSubkey,
      database: dependencies.database,
      deliver: sendMail,
      limiter: dependencies.limiter,
      ledger,
      logger: dependencies.logger,
      ids: dependencies.ids,
      clock: dependencies.clock,
      appendSessionRevoked: dependencies.appendSessionRevoked,
      revokeOtherSessions: dependencies.revokeOtherSessions,
      completeEmailChange: dependencies.completeEmailChange,
      revokeSessionUnlessAddressHeld:
        dependencies.revokeSessionUnlessAddressHeld,
      afterResponse,
    }),
    limiter: dependencies.limiter,
    logger: dependencies.logger,
    clock: dependencies.clock,
    settled: afterResponse.settled,
    pendingWork: afterResponse.pending,
  };
}
