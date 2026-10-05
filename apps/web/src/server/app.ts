import type { Clock, IdGenerator } from '@offense-demo/clock';
import {
  readAuthConfig,
  readServerConfig,
  type AuthConfig,
} from '@offense-demo/config';
import { createDatabase } from '@offense-demo/db';
import { createAppError } from '@offense-demo/errors';
import { createLogger } from '@offense-demo/logger';
import { createDrainState } from '@offense-demo/observability';
import { createRedis } from '@offense-demo/redis';
import { createResendSender, type Fetch } from '../features/auth/mail';
import { createAuthRateLimiter } from '../features/auth/redis-limiter';
import { createAuthServer, type AuthServer } from '../features/auth/server';
import { createTerminalSender } from '../features/auth/terminal-mail';
import type { AfterResponseLimits } from '../features/auth/after-response';
import { createResendWebhook } from '../features/auth/webhook';
import { createAlertRecorder, withAlertRecording } from './alert-recorder';
import { createMetricsStore, type MetricsStore } from './metrics-store';

export type AppDependencies = {
  /** Raw environment, validated here and nowhere else. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Outbound HTTP (the Resend mail transport). */
  readonly fetch: Fetch;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Where log lines go; standard output when omitted. */
  readonly logDestination?: { readonly write: (line: string) => void };
  /**
   * Where the local-development terminal mailer prints (ADR 0050); the
   * server's stderr when omitted. Never the log destination.
   */
  readonly devMailDestination?: { readonly write: (chunk: string) => unknown };
  /**
   * Narrower bounds for auth's handed-off work, for suites that must fill
   * them with a few requests; production uses the defaults.
   */
  readonly afterResponseLimits?: AfterResponseLimits;
  /** A ready Redis client in place of dialing `REDIS_URL`: the seam integration suites bound key expiry at (ISSUE-237). */
  readonly redisClient?: NonNullable<
    Parameters<typeof createRedis>[0]['client']
  >;
};

/**
 * The composition root: one call builds the whole web application graph
 * (validated config, logger, database, Redis, auth, rate limiter, mail and
 * the delivery webhook) from explicit dependencies. It reads no ambient
 * state, so any number of instances coexist in one process; only the
 * process edge (`process-app.ts`) keeps one for the server to share.
 *
 * Database and Redis clients dial lazily, so building an app contacts
 * nothing. Auth configuration is validated when auth is first used (ADR
 * 0020: baseline startup never requires auth variables); each instance
 * composes auth at most once.
 */
export function createApp({
  env,
  fetch,
  clock,
  ids,
  logDestination,
  devMailDestination,
  afterResponseLimits,
  redisClient,
}: AppDependencies) {
  const config = readServerConfig(env);
  const baseLogger = createLogger({
    service: 'web',
    level: config.LOG_LEVEL,
    appVersion: config.APP_VERSION,
    gitCommit: config.GIT_COMMIT,
    ...(logDestination ? { destination: logDestination } : {}),
  });
  const metrics: MetricsStore = createMetricsStore();
  const redis = createRedis({
    url: config.REDIS_URL,
    namespace: config.REDIS_NAMESPACE,
    eventSink: baseLogger.log,
    ...(redisClient ? { client: redisClient } : {}),
  });
  const alertRecorder = createAlertRecorder({ redis, clock });
  // AUTH-7.7: every existing `logger.log` call site (auth, retention, HTTP)
  // feeds both the durable Redis alert state and the in-process metrics
  // counters, once each, with no per-site change.
  const logger = withAlertRecording(baseLogger, alertRecorder, metrics);
  const database = createDatabase({
    url: config.DATABASE_URL,
    eventSink: logger.log,
  });
  let authConfig: AuthConfig | undefined;
  let auth: AuthServer | undefined;
  let mailWebhook: ReturnType<typeof createResendWebhook> | undefined;
  /** Parsed once, on first use, and shared by auth and the webhook. */
  const readAuth = (): AuthConfig => (authConfig ??= readAuthConfig(env));
  const composeAuth = (): AuthServer => {
    const authConfig = readAuth();
    return createAuthServer({
      config: authConfig,
      database: database.authAdapter,
      emailSender:
        authConfig.mailTransport === 'resend'
          ? createResendSender({
              apiKey: authConfig.RESEND_API_KEY,
              from: authConfig.AUTH_EMAIL_FROM,
              ids,
              fetch,
            })
          : createTerminalSender({
              nodeEnv: config.NODE_ENV,
              ids,
              ...(devMailDestination
                ? { destination: devMailDestination }
                : {}),
            }),
      limiter: createAuthRateLimiter(redis),
      ledger: {
        isSuppressed: (hash) => database.isRecipientSuppressed(hash),
        record: (input) => database.recordEmailDelivery(input),
      },
      appendSessionRevoked: (userId) => database.appendSessionRevoked(userId),
      revokeOtherSessions: (userId, keepToken) =>
        database.revokeOtherSessions(userId, keepToken),
      completeEmailChange: (input) => database.completeEmailChange(input),
      revokeSessionUnlessAddressHeld: (input) =>
        database.revokeSessionUnlessAddressHeld(input),
      logger,
      clock,
      ids,
      afterResponseLimits,
    });
  };
  const composeMailWebhook = () => {
    const authConfig = readAuth();
    // Refuses rather than accept unsigned deliveries, and has nothing to
    // verify against when the terminal mailer (ADR 0050) sends nothing.
    if (
      !authConfig.RESEND_WEBHOOK_SECRET ||
      authConfig.mailTransport !== 'resend'
    )
      throw createAppError('INFRASTRUCTURE');
    return createResendWebhook({
      secret: authConfig.RESEND_WEBHOOK_SECRET,
      apiKey: authConfig.RESEND_API_KEY,
      clock,
      apply: (input) => database.applyEmailDeliveryEvent(input),
    });
  };
  const drainState = createDrainState([database, redis]);
  return {
    config,
    clock,
    ids,
    logger,
    database,
    redis,
    /** AUTH-7.7's bounded-cardinality in-process counters (`/api/ops/metrics`). */
    metrics,
    /** The alert state this process keeps without Redis (ISSUE-191). */
    localAlertState: {
      limiterUnavailableSince: () => alertRecorder.limiterUnavailableSince(),
    },
    /** The composed auth server, validated and built on first use. */
    auth: (): AuthServer => (auth ??= composeAuth()),
    /**
     * `OPS_PROBE_TOKEN` (AUTH-7.7): refuses, like the webhook secret, rather
     * than serve `/api/ops/alerts`/`/api/ops/metrics` unauthenticated.
     */
    opsProbeToken: (): string => {
      const token = readAuth().OPS_PROBE_TOKEN;
      if (!token) throw createAppError('INFRASTRUCTURE');
      return token;
    },
    /** The Resend delivery webhook; refuses when the signing secret is unset. */
    mailWebhook: () => (mailWebhook ??= composeMailWebhook()),
    /**
     * Logs how much auth work handed off past its answer is still unfinished
     * (`auth.mail.abandoned`, a count only) when a shutdown's deadline cuts
     * it off (ISSUE-214). Silent when there is none.
     */
    reportUnfinishedWork: () => {
      const pending = auth?.pendingWork() ?? 0;
      if (pending > 0)
        logger.log(
          'auth.mail.abandoned',
          { operation: 'server.shutdown', pending },
          'Auth work after the answer was cut off by the shutdown deadline',
        );
    },
    isDraining: drainState.isDraining,
    drain: drainState.drain,
    /**
     * Drains, lets auth finish the work it answered before doing (ISSUE-185),
     * then closes both pools.
     */
    close: async () => {
      drainState.drain();
      await auth?.settled();
      await drainState.close();
    },
  };
}

export type App = ReturnType<typeof createApp>;
