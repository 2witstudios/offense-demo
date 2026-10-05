/**
 * Pure naming and port rules for local slots (ADR 0034), split from
 * slot-model.ts: how the project slug becomes database, role and Redis
 * namespace names, and how the shared stack's host ports are overridden.
 */
type Env = Readonly<Record<string, string | undefined>>;

// Postgres identifiers longer than this are silently truncated.
const POSTGRES_MAX_IDENTIFIER = 63;
// REDIS_NAMESPACE is ^[a-z][a-z0-9-]{0,62}$ (packages/config, packages/redis).
const REDIS_NAMESPACE_MAX = 63;
/** The shortest worktree slot id a slug must leave room for (`wt-3ctbm0tw`). */
const MIN_SLOT_ID_LENGTH = 8;
// The longest suffix a slot database carries: `_test_run_<8 hex>`.
const LONGEST_DATABASE_SUFFIX = '_test_run_00000000'.length;

/**
 * Slot names derived from the project slug. The slug may be kebab-case
 * (`widget-app`): Redis namespaces keep it, but Postgres database and role
 * names use its snake form (`widget_app`) so they stay valid unquoted
 * identifiers. The id budget is what is left once `<slug>-wt-<id>-e2e`
 * fits REDIS_NAMESPACE (^[a-z][a-z0-9-]{0,62}$) and the longest database
 * name fits a Postgres identifier.
 */
export function slotNaming(slug: string): {
  readonly databaseBase: string;
  readonly namespaceBase: string;
  readonly worktreeDatabasePrefix: string;
  readonly worktreeNamespacePrefix: string;
  readonly maxIdLength: number;
} {
  const databaseBase = slug.replaceAll('-', '_');
  const worktreeDatabasePrefix = `${databaseBase}_wt_`;
  const worktreeNamespacePrefix = `${slug}-wt-`;
  const maxIdLength = Math.min(
    REDIS_NAMESPACE_MAX - worktreeNamespacePrefix.length - '-e2e'.length,
    POSTGRES_MAX_IDENTIFIER -
      worktreeDatabasePrefix.length -
      LONGEST_DATABASE_SUFFIX,
  );
  if (maxIdLength < MIN_SLOT_ID_LENGTH)
    throw new Error(
      `Project slug "${slug}" is too long for worktree slots (ids would be limited to ${maxIdLength} characters)`,
    );
  return {
    databaseBase,
    namespaceBase: slug,
    worktreeDatabasePrefix,
    worktreeNamespacePrefix,
    maxIdLength,
  };
}

/**
 * The shared stack's host ports, overridable so several projects can run
 * their own stacks side by side: infra/compose.yaml publishes Postgres on
 * `${OFFENSE_DEMO_POSTGRES_PORT:-15432}` and Redis on `${OFFENSE_DEMO_REDIS_PORT:-6379}`,
 * and these are the same variables.
 */
export const STACK_PORT_ENV = {
  postgres: 'OFFENSE_DEMO_POSTGRES_PORT',
  redis: 'OFFENSE_DEMO_REDIS_PORT',
} as const;

const stackPort = (portEnv: Env, key: string): string | undefined => {
  const raw = portEnv[key];
  if (raw === undefined || raw === '') return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${key} must be a port number (1-65535), got "${raw}"`);
  return String(port);
};

const withPort = (url: string | undefined, port: string | undefined) => {
  if (url === undefined || port === undefined) return url;
  const next = new URL(url);
  next.port = port;
  return next.toString();
};

/**
 * The stack URLs with their ports moved to the configured host ports, when
 * set (`portEnv` is the process environment over the .env file); unset
 * leaves each URL as written.
 */
export function withStackPorts<T extends Env>(env: T, portEnv: Env): T {
  const postgres = stackPort(portEnv, STACK_PORT_ENV.postgres);
  const redis = stackPort(portEnv, STACK_PORT_ENV.redis);
  const moved = (keys: readonly string[], port: string | undefined) =>
    Object.fromEntries(
      keys
        .filter((key) => env[key] !== undefined)
        .map((key) => [key, withPort(env[key], port)]),
    );
  return {
    ...env,
    ...moved(['DATABASE_URL', 'TEST_DATABASE_URL'], postgres),
    ...moved(['REDIS_URL', 'E2E_REDIS_URL', 'TEST_REDIS_URL'], redis),
  };
}
