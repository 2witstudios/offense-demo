import { createHash } from 'node:crypto';
import type { AuthRateLimiter } from './rate-limit';

type ConsumingRedis = {
  readonly consumeRateLimit: (
    key: string,
    rule: { readonly windowSeconds: number; readonly max: number },
  ) => Promise<{
    readonly allowed: boolean;
    readonly retryAfterSeconds: number;
  }>;
};

/**
 * Shared limiter over the existing @offense-demo/redis client. Untrusted identifiers
 * (IPs, paths, recipients) are hashed into a valid key segment; a Redis outage
 * rejects so callers fail closed. There is deliberately no local fallback.
 */
export function createAuthRateLimiter(redis: ConsumingRedis): AuthRateLimiter {
  return {
    consume: (key, rule) =>
      redis.consumeRateLimit(
        createHash('sha3-256').update(key).digest('hex'),
        rule,
      ),
  };
}
