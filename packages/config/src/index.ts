import { z } from 'zod';
import {
  MAIL_FIELDS,
  terminalMailerAllowed,
  type AuthMailTransport,
} from './auth-mail-transport';
import { databaseUrl, redisUrl } from './urls';

export { requireTestServices, requireTestSlotServices } from './test-services';
export {
  expectedTestRedisDatabase,
  testRedisDatabase,
  testRedisRefusal,
} from './test-redis';

/**
 * Fields whose value is a credential or carries one (a password inside a
 * connection URL). Marked where each field is declared, so the list of
 * secret keys is derived from the schemas rather than kept by hand.
 */
const secrets = z.registry<{ readonly secret: true }>();
const secret = <Schema extends z.ZodType>(schema: Schema): Schema => {
  secrets.add(schema, { secret: true });
  return schema;
};

/** `AUTH_TRUSTED_PROXIES` keyword: trust this machine's default gateway. */
export const TRUSTED_PROXY_GATEWAY = 'gateway';

const requireHttpsOrigin = (url: string, ctx: z.RefinementCtx) => {
  if (!url.startsWith('https:'))
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_APP_URL'],
      message: 'Production requires HTTPS',
    });
};
/**
 * Shared across every deployment's config schema (`readServerConfig`,
 * `readRealtimeConfig`): production refuses to boot without a real
 * `APP_VERSION`/`GIT_COMMIT` and never against local-development
 * PostgreSQL credentials.
 */
const requireDeploymentIdentity = (
  config: {
    APP_VERSION: string;
    GIT_COMMIT: string;
    DATABASE_URL: string;
    MIGRATION_DATABASE_URL?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  // ISSUE-102: the schema owner lives only in the release-only migrator app
  // (ADR 0041); a runtime machine holding it is a misplaced Fly secret.
  if (config.MIGRATION_DATABASE_URL !== undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['MIGRATION_DATABASE_URL'],
      message: 'Production runtime must not hold the migration credential',
    });
  if (config.APP_VERSION === 'development' || config.GIT_COMMIT === 'unknown')
    ctx.addIssue({
      code: 'custom',
      path: ['APP_VERSION'],
      message: 'Production requires deployment identity',
    });
  if (new URL(config.DATABASE_URL).password === 'local-development-only')
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'Production forbids local development credentials',
    });
};
const deploymentIdentityFields = {
  // Required, no default: an unset NODE_ENV must refuse to start rather than
  // silently become 'development' and skip every production check below.
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: secret(databaseUrl),
  REDIS_URL: secret(redisUrl),
  REDIS_NAMESPACE: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .default('offense-demo'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  APP_VERSION: z.string().min(1).default('development'),
  GIT_COMMIT: z.string().min(1).default('unknown'),
  // Read only so production can refuse it; never part of the parsed config.
  MIGRATION_DATABASE_URL: secret(z.string()).optional(),
};
/** Drops the migration credential a runtime reads only to refuse it. */
const withoutMigrationCredential = <Config extends object>(
  config: Config & { MIGRATION_DATABASE_URL?: string | undefined },
): Omit<Config, 'MIGRATION_DATABASE_URL'> => {
  const { MIGRATION_DATABASE_URL: refused, ...runtime } = config;
  void refused;
  return runtime;
};
const serverFields = {
  ...deploymentIdentityFields,
  PUBLIC_APP_URL: z.url(),
};
const serverConfigSchema = z
  .object(serverFields)
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;
    requireHttpsOrigin(config.PUBLIC_APP_URL, ctx);
    requireDeploymentIdentity(config, ctx);
  })
  .transform(withoutMigrationCredential);
export type ServerConfig = z.output<typeof serverConfigSchema>;
/** Validation reports field names only: never echo secret values. */
export function readServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const result = serverConfigSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid server configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return result.data;
}
/**
 * `apps/realtime`'s baseline configuration (ADR 0031): no public origin,
 * which the realtime deployment has no use for yet.
 */
const realtimeConfigSchema = z
  .object(deploymentIdentityFields)
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;
    requireDeploymentIdentity(config, ctx);
  })
  .transform(withoutMigrationCredential);
export type RealtimeConfig = z.output<typeof realtimeConfigSchema>;
/** Validation reports field names only: never echo secret values. */
export function readRealtimeConfig(
  env: Record<string, string | undefined>,
): RealtimeConfig {
  const result = realtimeConfigSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid realtime configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return result.data;
}
// IPv6 that embeds IPv4: dotted notation, or the IPv4-mapped block ::ffff:0:0/96
// written in hex (only zero groups, then ffff, then exactly two groups).
const embedsIpv4 = (value: string) =>
  value.includes('.') ||
  /^[0:]*:ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/i.test(value.split('/')[0] ?? '');
// The accepted set must stay a subset of what Better Auth acts on: it drops
// an entry it cannot parse with only a warning, quietly untrusting a real
// proxy. It reduces IPv4-mapped IPv6 to four bytes and caps that prefix at
// 32, so mapped ranges are refused outright; operators write the IPv4 form.
// Stricter than Better Auth on purpose (no leading-zero prefixes either).
// The literal keyword instead trusts this machine's single default gateway,
// resolved once at the server edge (apps/web/src/server/trusted-proxies.ts):
// on Fly that is the one address fly-proxy connects from (ISSUE-162).
const proxyAddress = z.union([
  z.ipv4(),
  z.cidrv4(),
  z.union([z.ipv6(), z.cidrv6()]).refine((value) => !embedsIpv4(value)),
  z.literal(TRUSTED_PROXY_GATEWAY),
]);
/** Optional comma-separated list: absent or blank means an empty list. */
const commaList = (entry: z.ZodType<string, string>) =>
  z
    .string()
    .default('')
    .transform((value) =>
      value.trim() === '' ? [] : value.split(',').map((item) => item.trim()),
    )
    .pipe(z.array(entry));
/**
 * Narrow server authentication configuration, validated only when the auth
 * composition is activated: baseline startup never requires auth variables.
 */
const authFields = {
  /** 64 characters from 32 random bytes (hex); see `bun auth:provision`. */
  BETTER_AUTH_SECRET: secret(z.string().regex(/^\S{64}$/)),
  /**
   * 64 characters from 32 random bytes (hex); see `bun auth:provision`.
   * Keys `recipientKey` (the suppression ledger and per-recipient
   * rate-limit buckets) independently of `BETTER_AUTH_SECRET`, so rotating
   * the session-signing secret can never desynchronize them (ADR 0044,
   * ISSUE-141).
   */
  RECIPIENT_HASH_SECRET: secret(z.string().regex(/^\S{64}$/)),
  PUBLIC_APP_URL: z.url().refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Expected HTTP(S) URL'),
  /**
   * Required with `AUTH_EMAIL_FROM` everywhere except local development,
   * where leaving both unset selects the terminal mailer (ADR 0050).
   */
  RESEND_API_KEY: secret(z.string().regex(/^\S+$/)).optional(),
  /** Sender email header value; newlines and malformed mailboxes are rejected. */
  AUTH_EMAIL_FROM: z
    .string()
    .refine(
      (value) =>
        /^(?:[^<>\r\n]+ <[^\s@<>]+@[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+)$/.test(
          value,
        ),
      'Expected an email address or display name with an email address',
    )
    .optional(),
  /** Resend (Svix) signing secret for delivery webhooks; required in production. */
  RESEND_WEBHOOK_SECRET: secret(
    z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,}$/),
  ).optional(),
  /** Proxy IPs or CIDR ranges skipped when a trusted header holds a chain. */
  AUTH_TRUSTED_PROXIES: commaList(proxyAddress),
  /**
   * Bearer credential for the read-only `/api/ops/alerts` and
   * `/api/ops/metrics` probes (AUTH-7.7); required in production so the
   * scheduled alert workflow, and nothing else, can read them.
   */
  OPS_PROBE_TOKEN: secret(z.string().min(32)).optional(),
  // Required, no default: see deploymentIdentityFields.NODE_ENV.
  NODE_ENV: z.enum(['development', 'test', 'production']),
};
/** Fields that must be set once NODE_ENV is production, each reported by name only. */
const REQUIRED_IN_PRODUCTION = [
  ['RESEND_WEBHOOK_SECRET', 'Production requires the webhook signing secret'],
  ['OPS_PROBE_TOKEN', 'Production requires the ops probe token'],
] as const;
const authObject = z.object(authFields);
type AuthBase = Omit<
  z.output<typeof authObject>,
  'NODE_ENV' | (typeof MAIL_FIELDS)[number]
>;
export type AuthConfig = AuthBase & AuthMailTransport;
const authConfigSchema = authObject
  .superRefine((config, ctx) => {
    if (!terminalMailerAllowed(config))
      for (const field of MAIL_FIELDS)
        if (config[field] === undefined)
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'Auth mail requires Resend outside local development',
          });
    if (config.NODE_ENV !== 'production') return;
    requireHttpsOrigin(config.PUBLIC_APP_URL, ctx);
    for (const [field, message] of REQUIRED_IN_PRODUCTION)
      if (config[field] === undefined)
        ctx.addIssue({ code: 'custom', path: [field], message });
  })
  .transform(
    ({
      NODE_ENV: _nodeEnv,
      RESEND_API_KEY,
      AUTH_EMAIL_FROM,
      ...auth
    }): AuthConfig =>
      RESEND_API_KEY !== undefined && AUTH_EMAIL_FROM !== undefined
        ? { ...auth, mailTransport: 'resend', RESEND_API_KEY, AUTH_EMAIL_FROM }
        : { ...auth, mailTransport: 'terminal' },
  );
/** Validation reports field names only: never echo secret values. */
export function readAuthConfig(
  env: Record<string, string | undefined>,
): AuthConfig {
  const result = authConfigSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid auth configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return result.data;
}
/**
 * The migration runner's credential (ISSUE-39). Production (the release
 * command runs in the image, which sets NODE_ENV=production) migrates only
 * through MIGRATION_DATABASE_URL, the schema owner, and refuses one that
 * names the same role as the runtime DATABASE_URL, which production holds
 * as the DML-only `offense_demo_web`. Local and test databases have one owner
 * login, so outside production DATABASE_URL serves unless a migration
 * credential is named.
 */
const migrationFields = {
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  MIGRATION_DATABASE_URL: secret(databaseUrl).optional(),
  DATABASE_URL: secret(databaseUrl).optional(),
};
const migrationConfigSchema = z
  .object(migrationFields)
  .superRefine((config, ctx) => {
    const production = config.NODE_ENV === 'production';
    const url = production
      ? config.MIGRATION_DATABASE_URL
      : (config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL);
    if (url === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [production ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL'],
        message: 'required',
      });
      return;
    }
    if (!production) return;
    if (new URL(url).password === 'local-development-only')
      ctx.addIssue({
        code: 'custom',
        path: ['MIGRATION_DATABASE_URL'],
        message: 'production forbids local development credentials',
      });
    if (
      config.DATABASE_URL !== undefined &&
      new URL(config.DATABASE_URL).username === new URL(url).username
    )
      ctx.addIssue({
        code: 'custom',
        path: ['MIGRATION_DATABASE_URL'],
        message: 'must name a different role than DATABASE_URL',
      });
  })
  .transform((config) => ({
    databaseUrl: (config.NODE_ENV === 'production'
      ? config.MIGRATION_DATABASE_URL
      : (config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL)) as string,
  }));
export type MigrationConfig = z.infer<typeof migrationConfigSchema>;
/** Validation reports field names only: never echo secret values. */
export function readMigrationConfig(
  env: Record<string, string | undefined>,
): MigrationConfig {
  const result = migrationConfigSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid migration configuration: ${result.error.issues
        .map((issue) =>
          issue.code === 'custom' && issue.message !== 'required'
            ? `${issue.path.join('.')} (${issue.message})`
            : issue.path.join('.'),
        )
        .join(', ')}`,
    );
  return result.data;
}
export function readBrowserConfig(env: Record<string, string | undefined>) {
  return z
    .object({ PUBLIC_APP_URL: z.url() })
    .parse({ PUBLIC_APP_URL: env.PUBLIC_APP_URL });
}
const unwrapOptional = (schema: z.ZodType): z.ZodType =>
  schema instanceof z.ZodOptional
    ? unwrapOptional(schema.unwrap() as z.ZodType)
    : schema;

/**
 * Every configuration key marked secret in the server, realtime, auth and
 * migration schemas: the list the logger's redaction tests are derived from (ADR 0019).
 */
export const secretConfigKeys: readonly string[] = [
  ...new Set(
    Object.entries({ ...serverFields, ...authFields, ...migrationFields })
      .filter(([, schema]) => secrets.has(unwrapOptional(schema)))
      .map(([key]) => key),
  ),
];
