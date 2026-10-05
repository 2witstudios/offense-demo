/**
 * Probes for the shared local stack (ADR 0034). Development tooling only.
 */
import { RedisClient, SQL } from 'bun';

/** `url` pointed at another database of the same server. */
export const withDatabase = (url: string, database: string) => {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
};

/**
 * Probes the stack with throwaway clients: a Bun RedisClient that failed
 * once never reconnects, so the clients slot:up works with are opened only
 * after the stack is known to be up.
 */
export async function stackReachable(
  env: Readonly<Record<string, string | undefined>>,
) {
  const probe = new SQL(withDatabase(env.DATABASE_URL ?? '', 'postgres'), {
    max: 1,
    connectionTimeout: 3,
  });
  const redis = new RedisClient(env.REDIS_URL ?? '', {
    connectionTimeout: 2000,
    maxRetries: 0,
    enableOfflineQueue: false,
  });
  try {
    await probe`select 1`;
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.close();
    await probe.close({ timeout: 1 });
  }
}
