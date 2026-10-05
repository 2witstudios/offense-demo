/**
 * The .env half of local slots (ADR 0034), split from slot-model.ts: the
 * values `bun slot:up` writes for a slot and the pure reading and rewriting
 * of .env text.
 */
import { testRedisDatabase } from '@offense-demo/config';
import { e2eRole, type Slot } from './slot-model';
import { APP_PORT_ENV, mainAppPort, slotPorts } from './slot-ports';

type Env = Readonly<Record<string, string | undefined>>;

const e2eRedisDatabase = 2;

const withPath = (
  url: string,
  path: string,
  credentials?: typeof e2eRole,
): string => {
  const next = new URL(url);
  next.pathname = `/${path}`;
  if (credentials) {
    next.username = credentials.user;
    next.password = credentials.password;
  }
  return next.toString();
};

const requireEnv = (env: Env, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`${key} is required in .env`);
  return value;
};

/** Every .env key `bun slot:up` owns (see slotEnvValues). */
const slotEnvKeys = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'REDIS_NAMESPACE',
  'E2E_DATABASE_URL',
  'E2E_REDIS_URL',
  'E2E_REDIS_NAMESPACE',
  'TEST_REDIS_URL',
  'PORT',
  'PUBLIC_APP_URL',
  'E2E_PORT',
  'REALTIME_PORT',
] as const;

/**
 * The slot's .env values. The server (host, port, credentials) comes from
 * the existing URLs, which is how the admin connection is injected.
 */
export function slotEnvValues({
  slot,
  env,
  portBlock,
}: {
  readonly slot: Slot;
  readonly env: Env;
  readonly portBlock?: number;
}): Readonly<Record<(typeof slotEnvKeys)[number], string>> {
  const databaseUrl = requireEnv(env, 'DATABASE_URL');
  const redisUrl = requireEnv(env, 'REDIS_URL');
  const ports = slotPorts(slot.kind, portBlock, mainAppPort(env[APP_PORT_ENV]));
  return {
    DATABASE_URL: withPath(databaseUrl, slot.database),
    // Every slot URL shares DATABASE_URL's server, so a stale test URL left
    // on an old per-session server cannot split the slot across two stacks.
    TEST_DATABASE_URL: withPath(databaseUrl, slot.testDatabase),
    REDIS_NAMESPACE: slot.namespace,
    E2E_DATABASE_URL: withPath(databaseUrl, slot.e2eDatabase, e2eRole),
    E2E_REDIS_URL: e2eRedisUrl(redisUrl),
    E2E_REDIS_NAMESPACE: slot.e2eNamespace,
    TEST_REDIS_URL: withPath(
      redisUrl,
      String(testRedisDatabase(slot.kind === 'main' ? undefined : portBlock)),
    ),
    PORT: String(ports.app),
    PUBLIC_APP_URL: `http://localhost:${ports.app}`,
    E2E_PORT: String(ports.e2e),
    REALTIME_PORT: String(ports.realtime),
  };
}

/** The Redis database the browser suite's server uses, beside the dev one. */
export const e2eRedisUrl = (redisUrl: string): string =>
  withPath(redisUrl, String(e2eRedisDatabase));

const assignment = (key: string) => new RegExp(`^${key}=(.*)$`, 'gm');

export function readEnvValue(content: string, key: string): string | undefined {
  return [...content.matchAll(assignment(key))].at(-1)?.[1];
}

/**
 * The environment for processes started after `slot:up` rewrote .env: the
 * slot values come from the file, because values inherited from a parent
 * (Bun loads .env on start) would otherwise win over `--env-file`.
 */
export function withSlotEnv(env: Env, content: string): Env {
  const fresh = Object.fromEntries(
    slotEnvKeys
      .map((key) => [key, readEnvValue(content, key)] as const)
      .filter(([, value]) => value !== undefined),
  );
  return { ...env, ...fresh };
}

/** Rewrites every canonical `KEY=` line; appends keys the file lacks. */
export function rewriteEnv(
  content: string,
  values: Readonly<Record<string, string>>,
): { readonly content: string; readonly changed: boolean } {
  let next = content;
  for (const [key, value] of Object.entries(values)) {
    if (readEnvValue(next, key) === undefined)
      next = `${next}${next && !next.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    else next = next.replace(assignment(key), () => `${key}=${value}`);
  }
  return { content: next, changed: next !== content };
}
