import type { LoadServices } from './two-instances';

/**
 * A local dry run reuses this checkout's e2e database and Redis namespace
 * (`bun slot:up` provisions `offense_demo_e2e`, a non-development credential that
 * satisfies production configuration's refusal of `local-development-only`
 * passwords) instead of provisioning anything new. Never run a local dry
 * run at the same time as `bun test:e2e` in this checkout: both would share
 * the same database, Redis namespace and rate-limit buckets.
 */
export function localServices(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LoadServices {
  const databaseUrl = env.E2E_DATABASE_URL;
  const redisUrl = env.E2E_REDIS_URL;
  const redisNamespace = env.E2E_REDIS_NAMESPACE;
  if (!databaseUrl || !redisUrl || !redisNamespace)
    throw new Error(
      'E2E_DATABASE_URL, E2E_REDIS_URL and E2E_REDIS_NAMESPACE are required for a local dry run (run `bun slot:up`)',
    );
  return { databaseUrl, redisUrl, redisNamespace };
}
