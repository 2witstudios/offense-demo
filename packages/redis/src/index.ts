import { RedisClient } from 'bun';
import { createPresenceOperations } from './presence';
import { createTicketOperations } from './ticket';
import { redisKey } from './redis-key';
import { defineScript } from './script-registry';
import type { RedisTransport } from './transport';
export { redisKey } from './redis-key';
export type RedisConfig = { readonly url: string; readonly namespace: string };
export type RedisEventSink = (
  event: 'redis.command.failed',
  fields: Readonly<Record<string, unknown>>,
  message: string,
) => void;
/**
 * Fixed-window counter in ONE atomic script: increment, arm the expiry on the
 * first hit (or if it is somehow missing), and decide. Denied attempts keep
 * counting, so the decision never depends on read-modify-write across calls.
 * KEYS[1] key; ARGV[1] window ms; ARGV[2] max. Returns {allowed, ttlMs}.
 */
const consumeScript = defineScript(`
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if count > tonumber(ARGV[2]) then return {0, ttl} end
return {1, ttl}
`);

/**
 * ARGV[1] value, ARGV[2] TTL ms. AUTH-7.7's "since" markers (an outage's
 * start): the first occurrence wins the write and every later occurrence
 * reads back that same value, so a racing write can never overwrite an
 * earlier start time — but every occurrence (winner or not) re-arms the
 * TTL, so a continuous run of occurrences spaced closer than the TTL keeps
 * the marker alive indefinitely instead of expiring 180s after only the
 * first one.
 */
const markOccurrenceSinceScript = defineScript(`
local existing = redis.call('GET', KEYS[1])
if existing then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return existing
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return ARGV[1]
`);

/**
 * ARGV[1] TTL ms, armed only on the first hit. AUTH-7.7's bounded counters
 * (consecutive failures, per-minute request buckets): a quiet period longer
 * than the TTL resets the count to zero on the next increment.
 */
const incrementWithExpiryScript = defineScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`);
export type RateLimitRule = {
  readonly windowSeconds: number;
  readonly max: number;
};
/** How the adapter dials: fail fast, never queue commands while offline. */
export const redisClientOptions = {
  connectionTimeout: 2000,
  enableOfflineQueue: false,
  maxRetries: 2,
} as const;

export function createRedis({
  url,
  namespace,
  eventSink,
  client: injectedClient,
}: RedisConfig & {
  readonly eventSink?: RedisEventSink;
  /** Overrides dialing `url`; tests inject a scripted client at this seam. */
  readonly client?: RedisTransport;
}) {
  redisKey(namespace);
  const client = injectedClient ?? new RedisClient(url, redisClientOptions);
  const reportFailure = (operation: string) =>
    eventSink?.('redis.command.failed', { operation }, 'Redis command failed');
  return {
    async health() {
      try {
        await client.connect();
        return (await client.ping()) === 'PONG';
      } catch (error) {
        reportFailure('health');
        throw error;
      }
    },
    async setEphemeral(key: string, value: string, ttlSeconds: number) {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
        throw new Error('TTL must be a positive integer');
      try {
        await client.connect();
        await client.send('SET', [
          redisKey(namespace, key),
          value,
          'EX',
          String(ttlSeconds),
        ]);
      } catch (error) {
        reportFailure('setEphemeral');
        throw error;
      }
    },
    /** Atomic across instances; throws on outage so callers must fail closed. */
    async consumeRateLimit(key: string, rule: RateLimitRule) {
      if (
        !Number.isSafeInteger(rule.windowSeconds) ||
        rule.windowSeconds < 1 ||
        !Number.isSafeInteger(rule.max) ||
        rule.max < 1
      )
        throw new Error('Invalid rate limit rule');
      const namespaced = redisKey(namespace, 'rl', key);
      try {
        await client.connect();
        const [allowed, ttlMs] = (await client.send('EVAL', [
          consumeScript,
          '1',
          namespaced,
          String(rule.windowSeconds * 1000),
          String(rule.max),
        ])) as [number, number];
        return {
          allowed: allowed === 1,
          retryAfterSeconds: allowed === 1 ? 0 : Math.ceil(ttlMs / 1000),
        };
      } catch (error) {
        reportFailure('consumeRateLimit');
        throw error;
      }
    },
    /**
     * Writes `value` under `key` only on the first call, with a mandatory
     * TTL that every later call re-arms, and returns whichever value is now
     * stored (the caller's, or an earlier winner's). AUTH-7.7 uses this to
     * mark the start of an outage once, even under concurrent instances,
     * and keep that since-time alive across a continuous run of failures.
     */
    async markOccurrenceSince(key: string, value: string, ttlSeconds: number) {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
        throw new Error('TTL must be a positive integer');
      try {
        await client.connect();
        return (await client.send('EVAL', [
          markOccurrenceSinceScript,
          '1',
          redisKey(namespace, key),
          value,
          String(ttlSeconds * 1000),
        ])) as string;
      } catch (error) {
        reportFailure('markOccurrenceSince');
        throw error;
      }
    },
    /**
     * Atomically increments a counter, arming its expiry on the first hit,
     * and returns the new count. AUTH-7.7's bounded consecutive-failure and
     * per-minute request counters.
     */
    async incrementWithExpiry(key: string, ttlSeconds: number) {
      if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
        throw new Error('TTL must be a positive integer');
      try {
        await client.connect();
        return (await client.send('EVAL', [
          incrementWithExpiryScript,
          '1',
          redisKey(namespace, key),
          String(ttlSeconds * 1000),
        ])) as number;
      } catch (error) {
        reportFailure('incrementWithExpiry');
        throw error;
      }
    },
    async get(key: string) {
      try {
        await client.connect();
        return await client.get(redisKey(namespace, key));
      } catch (error) {
        reportFailure('get');
        throw error;
      }
    },
    async delete(key: string) {
      try {
        await client.connect();
        await client.del(redisKey(namespace, key));
      } catch (error) {
        reportFailure('delete');
        throw error;
      }
    },
    ...createPresenceOperations({ client, namespace, reportFailure }),
    ...createTicketOperations({ client, namespace, reportFailure }),
    close() {
      client.close();
    },
  };
}
