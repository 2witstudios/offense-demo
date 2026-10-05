import { APIError, createAuthMiddleware, getIP } from 'better-auth/api';
import { createAppError } from '@offense-demo/errors';
import type { Logger } from '@offense-demo/logger';
import { recipientKey } from './recipient-key';
import { clientNetworks, type NetworkScope } from './client-networks';

/** Fixed-window allowance the gate asks the limiter to enforce for one key. */
type RateRule = {
  readonly windowSeconds: number;
  readonly max: number;
};
/** 100 requests per 60 seconds for every auth route ... */
const DEFAULT_RULE: RateRule = { windowSeconds: 60, max: 100 };
/** ... and 3 per 60 seconds for magic-link requests, per client. */
const MAGIC_LINK_CLIENT_RULE: RateRule = { windowSeconds: 60, max: 3 };
/**
 * One recipient's mail volume, multi-window: the 60 s rule alone admits
 * about 4,300 emails a day to one victim from rotating client addresses, so
 * an hour and a day ceiling each cap the total regardless of how the minute
 * window resets. Each mail flow keeps its own windows per recipient.
 */
const RECIPIENT_RULES: readonly RateRule[] = [
  { windowSeconds: 60, max: 3 },
  { windowSeconds: 3_600, max: 10 },
  { windowSeconds: 86_400, max: 20 },
];
/**
 * The whole application's sign-up mail volume, independent of any single
 * recipient or client: protects Resend quota, cost and sending-domain
 * reputation from many new addresses each staying under their own ceiling.
 * Every magic-link send counts against it, with or without an account, so
 * its remaining capacity never tells a caller which address has one
 * (ISSUE-188). Only sign-ups (links to addresses with no account) are held
 * back by it: past it a sign-in link is still sent, so one attacker draining
 * it (rotating client addresses, plus-addressed recipients) delays new
 * sign-ups but does not by itself deny sign-in (ISSUE-54); a flood past the
 * handed-off work's bound sheds sign-in mail too (DEC-73). Past it, a
 * sign-up's mail is dropped behind the ordinary success (ISSUE-182).
 */
const MAGIC_LINK_GLOBAL_RULES: readonly RateRule[] = [
  { windowSeconds: 60, max: 120 },
  { windowSeconds: 86_400, max: 3_000 },
];

/**
 * AUTH-3.10: magic-link requests per network, on top of the per-client
 * bucket. Better Auth keys an IPv6 client by its /64, so one /48 is 65,536
 * clients and could send about 3,277 magic-link requests a second at 3 a
 * minute each, enough to hold the handed-off work's 512-slot pool full
 * (ADR 0025). These cap a /56 (a typical household or small site) at 30 a
 * minute, a /48 (a typical organization, host or tunnel-broker allocation)
 * at 120 a minute, and an IPv4 /24 at 120 a minute: 2 a second per /48 or
 * /24, against a pool edge measured at 700 to 1,200 a second on the
 * development host, so filling the pool takes hundreds of distinct /48s
 * or /24s rather than one.
 */
export const MAGIC_LINK_NETWORK_RULES: Readonly<
  Record<NetworkScope, RateRule>
> = {
  ipv6_56: { windowSeconds: 60, max: 30 },
  ipv6_48: { windowSeconds: 60, max: 120 },
  ipv4_24: { windowSeconds: 60, max: 120 },
};

/** Atomic multi-instance limiter contract backed by @offense-demo/redis. */
export type AuthRateLimiter = {
  readonly consume: (
    key: string,
    rule: RateRule,
  ) => Promise<{
    readonly allowed: boolean;
    readonly retryAfterSeconds: number;
  }>;
};

/**
 * Better Auth's client-identity trust, fixed to the one header the ingress
 * itself stamps (`client-ip.ts`'s `CLIENT_IP_HEADER`, via
 * `stampClientIdentity`). That is the single resolver: the ingress walks the
 * real `X-Forwarded-For` chain past `AUTH_TRUSTED_PROXIES` once and replaces
 * any caller-supplied value, so Better Auth never re-parses forwarded
 * headers itself and has no second, redundant trust configuration.
 */
export const clientIpOptions = (headerName: string) => ({
  // An exact single-entry list (not undefined) is what stops Better Auth
  // falling back to its own default of believing `x-forwarded-for`.
  ipAddressHeaders: [headerName],
});

const magicLinkPath = '/sign-in/magic-link';

/**
 * The routes that mail an address named in their body, and that field: a
 * sign-in link to `email`, and an email change, whose approved request
 * mails `newEmail` a verification link or, when the address already has an
 * account, a notice (ISSUE-119, ISSUE-121).
 */
const MAILED_RECIPIENTS = {
  [magicLinkPath]: { flow: 'magic-link', field: 'email' },
  '/change-email': { flow: 'email-change', field: 'newEmail' },
} as const satisfies Readonly<
  Record<string, { readonly flow: string; readonly field: string }>
>;

type Recipient = { readonly flow: string; readonly email: string };

/** The address a request would mail, when its route mails one. */
const mailedRecipient = (
  path: string,
  body: unknown,
): Recipient | undefined => {
  const route = Object.hasOwn(MAILED_RECIPIENTS, path)
    ? MAILED_RECIPIENTS[path as keyof typeof MAILED_RECIPIENTS]
    : undefined;
  if (route === undefined || typeof body !== 'object' || body === null)
    return undefined;
  const email: unknown = Reflect.get(body, route.field);
  return typeof email === 'string' ? { flow: route.flow, email } : undefined;
};

type Bucket = {
  readonly key: string;
  readonly rule: RateRule;
  /** Set on a network bucket, so its denial is logged as one. */
  readonly scope?: NetworkScope;
};

// One bucket per network the client is in, keyed by the network (never the
// client's own address) and the window.
const networkBuckets = (client: string | null): Bucket[] =>
  clientNetworks(client).map(({ scope, network }) => {
    const rule = MAGIC_LINK_NETWORK_RULES[scope];
    return {
      key: `auth:magic-link:net:${scope}:${network}:${rule.windowSeconds}`,
      rule,
      scope,
    };
  });

// The per-recipient bucket is keyed by `recipientKey` (recipient-key.ts): a
// subkey-derived digest, so the address never reaches Redis keys or logs.
// It is keyed on the address alone, never on whether it has an account, so
// a refusal reveals nothing about that (ISSUE-119).
const recipientBuckets = (
  recipientSubkey: string,
  recipient: Recipient | undefined,
): Bucket[] => {
  if (recipient === undefined) return [];
  const key = recipientKey(recipientSubkey, recipient.email);
  return RECIPIENT_RULES.map((rule) => ({
    key: `auth:${recipient.flow}:recipient:${key}:${rule.windowSeconds}`,
    rule,
  }));
};

// One fixed key per window: shared by every recipient and client, so it caps
// the whole application's sign-up volume independent of any single
// recipient or client bucket.
const globalBuckets: readonly Bucket[] = MAGIC_LINK_GLOBAL_RULES.map(
  (rule) => ({ key: `auth:magic-link:global:${rule.windowSeconds}`, rule }),
);

// A valid hint is rounded up to whole seconds; an invalid one (NaN, negative,
// non-finite) omits the header rather than advertising a made-up wait.
const retryAfterHeaders = (retryAfterSeconds: unknown): HeadersInit =>
  typeof retryAfterSeconds === 'number' &&
  Number.isFinite(retryAfterSeconds) &&
  retryAfterSeconds >= 0
    ? { 'Retry-After': String(Math.ceil(retryAfterSeconds)) }
    : {};

// The limiter is an injected boundary: a decision without a boolean verdict
// is an outage, never an implicit allow and never a TypeError.
const readDecision = (decision: unknown) => {
  if (typeof decision !== 'object' || decision === null)
    throw new TypeError('Malformed limiter decision');
  const allowed: unknown = Reflect.get(decision, 'allowed');
  if (typeof allowed !== 'boolean')
    throw new TypeError('Malformed limiter decision');
  const retryAfterSeconds: unknown = Reflect.get(decision, 'retryAfterSeconds');
  return { allowed, retryAfterSeconds };
};

/**
 * The single-bucket atomic-limit gate a route runs before its durable work:
 * consume one decision, fail closed with `INFRASTRUCTURE` on outage or a
 * malformed answer, and refuse with `RATE_LIMIT` when denied. Callers with
 * more than one bucket (this file's own middleware, with its magic-link and
 * recipient buckets) stay on `readDecision` directly.
 */
export async function consumeOrThrow(
  limiter: AuthRateLimiter,
  key: string,
  rule: RateRule,
): Promise<void> {
  let decision: { readonly allowed: boolean };
  try {
    decision = readDecision(await limiter.consume(key, rule));
  } catch (error) {
    throw createAppError('INFRASTRUCTURE', undefined, error);
  }
  if (!decision.allowed) throw createAppError('RATE_LIMIT');
}

const logDenial = (
  logger: Logger,
  path: string,
  errorCode: 'RATE_LIMIT' | 'INFRASTRUCTURE',
) =>
  // Only the stable route path and code are logged: never the key, client
  // address, request body, or the limiter's raw exception. A denial is
  // expected traffic (warn); only an outage is an error.
  logger.log(
    errorCode === 'RATE_LIMIT'
      ? 'auth.rate_limit.denied'
      : 'auth.rate_limit.unavailable',
    { operation: 'auth.rate_limit', path, errorCode },
    errorCode === 'RATE_LIMIT'
      ? 'Auth request rate limited'
      : 'Auth rate limiter unavailable; request denied',
  );

const denial = (
  logger: Logger,
  path: string,
  errorCode: 'RATE_LIMIT' | 'INFRASTRUCTURE',
  retryAfterSeconds?: unknown,
  logged = true,
) => {
  if (logged) logDenial(logger, path, errorCode);
  return errorCode === 'RATE_LIMIT'
    ? new APIError(
        'TOO_MANY_REQUESTS',
        { message: 'Too many requests' },
        retryAfterHeaders(retryAfterSeconds),
      )
    : new APIError('SERVICE_UNAVAILABLE', {
        message: 'Service temporarily unavailable',
      });
};

/**
 * A server-side session read (`auth.api.getSession` from lib/identity.ts,
 * which has no Request) is Principal resolution: ADR 0020 orders it before
 * the rate-limit gate, which limits the operation the Principal then
 * performs. It must not spend the per-client auth budget, or busy or
 * NAT-shared clients would see guarded pages fail. Browser HTTP calls to
 * `/api/auth/get-session` always carry a Request and stay limited.
 */
const isServerPrincipalRead = (path: string, request: Request | undefined) =>
  path === '/get-session' && request === undefined;

/**
 * ADR 0020 rate-limit gate as a Better Auth `hooks.before` middleware. It
 * runs before every endpoint handler, for HTTP requests and direct
 * `auth.api.*` calls alike (except server Principal reads, above), so a
 * denied request performs no durable work.
 * A limiter outage fails closed with a public 503.
 *
 * `resolveClient` defaults to Better Auth's `getIP`, which believes only the
 * headers configured through `clientIpOptions`.
 */
export const createRateLimitGate = (dependencies: {
  readonly limiter: AuthRateLimiter;
  readonly logger: Logger;
  readonly recipientSubkey: string;
  readonly resolveClient?: typeof getIP;
}) =>
  createAuthMiddleware(async (context) => {
    const { path } = context;
    if (isServerPrincipalRead(path, context.request)) return;
    const resolveClient = dependencies.resolveClient ?? getIP;
    // Everything the gate depends on runs inside try/await, so client
    // resolution that throws and a limiter that throws synchronously,
    // rejects, or answers nonsense all converge on the same fail-closed 503.
    const failClosed = async <Result>(work: () => Result | Promise<Result>) => {
      try {
        return await work();
      } catch {
        throw denial(dependencies.logger, path, 'INFRASTRUCTURE');
      }
    };
    const recipient = mailedRecipient(path, context.body);
    const buckets = await failClosed((): Bucket[] => {
      // Direct `auth.api.*` calls carry no Request, only forwarded Headers.
      const source = context.request ?? context.headers;
      const client = source
        ? resolveClient(source, context.context.options)
        : null;
      return [
        {
          key: `auth:client:${client ?? 'unknown'}:${path}`,
          rule: path === magicLinkPath ? MAGIC_LINK_CLIENT_RULE : DEFAULT_RULE,
        },
        ...(path === magicLinkPath ? networkBuckets(client) : []),
        ...recipientBuckets(dependencies.recipientSubkey, recipient),
      ];
    });
    const consume = async (bucket: Bucket) => {
      const decision = await failClosed(async () =>
        readDecision(
          await dependencies.limiter.consume(bucket.key, bucket.rule),
        ),
      );
      if (!decision.allowed) {
        if (bucket.scope !== undefined)
          // Counts only: the scope, never the network, client or address.
          dependencies.logger.log(
            'auth.rate_limit.network_denied',
            { operation: 'auth.rate_limit', path, scope: bucket.scope },
            'Auth magic-link request rate limited for its network',
          );
        throw denial(
          dependencies.logger,
          path,
          'RATE_LIMIT',
          decision.retryAfterSeconds,
          bucket.scope === undefined,
        );
      }
    };
    for (const bucket of buckets) await consume(bucket);
  });

/**
 * The global sign-up ceilings, spent by every magic-link send
 * (`sign-in-mail.ts`) after the gate, destination and suppression checks,
 * whether or not the address has an account, so their remaining capacity
 * never depends on one (ISSUE-188). `false` when a ceiling is saturated:
 * the caller drops a sign-up's mail behind the ordinary success and still
 * sends a sign-in link (ISSUE-54, ISSUE-182). Operators see the saturation
 * as `auth.rate_limit.denied`, never the caller. A limiter outage fails
 * closed with the public 503.
 */
export const createSignUpCeiling =
  (dependencies: {
    readonly limiter: AuthRateLimiter;
    readonly logger: Logger;
  }) =>
  async (): Promise<boolean> => {
    for (const bucket of globalBuckets) {
      let allowed: boolean;
      try {
        ({ allowed } = readDecision(
          await dependencies.limiter.consume(bucket.key, bucket.rule),
        ));
      } catch {
        throw denial(dependencies.logger, magicLinkPath, 'INFRASTRUCTURE');
      }
      if (!allowed) {
        logDenial(dependencies.logger, magicLinkPath, 'RATE_LIMIT');
        return false;
      }
    }
    return true;
  };
