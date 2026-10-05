import { createHash } from 'node:crypto';
import { systemClock, systemId } from '@offense-demo/clock';
import { readAuthConfig } from '@offense-demo/config';
import { createDatabase } from '@offense-demo/db';
import { createRedis, redisKey } from '@offense-demo/redis';
import { openTestRedis } from '@offense-demo/redis/testing';
import { testDatabaseUrl, testRedisUrl, type TestApp } from './fixtures';
import { createAuthRouteHandlers } from '../src/features/auth/handlers';
import { createAuthRateLimiter } from '../src/features/auth/redis-limiter';
import {
  deriveRecipientSubkey,
  recipientKey,
} from '../src/features/auth/recipient-key';
import { createAuthServer } from '../src/features/auth/server';

const silentLogger = { log: () => {}, child: () => silentLogger };
const noLedger = { isSuppressed: async () => false, record: async () => {} };

/** The limiter's real Redis key for a gate bucket key (`redis-limiter.ts`). */
const limiterKey = (testApp: TestApp, bucket: string) =>
  redisKey(
    testApp.redisNamespace,
    'rl',
    createHash('sha3-256').update(bucket).digest('hex'),
  );

/** A recipient bucket key for one mail flow, as `rate-limit.ts` builds it. */
export const recipientBucket = (
  testApp: TestApp,
  flow: 'magic-link' | 'email-change',
  email: string,
  window: number,
) =>
  `auth:${flow}:recipient:${recipientKey(
    deriveRecipientSubkey(String(testApp.env.RECIPIENT_HASH_SECRET)),
    email,
  )}:${window}`;

/**
 * Fixed windows elapsing: each bucket's counter key expires in Redis, which
 * is what the limiter's PEXPIRE does when the window ends. Every other
 * bucket keeps its real count, so the ceiling under test is the one that
 * decides.
 */
export const elapse = async (testApp: TestApp, ...buckets: string[]) => {
  const client = openTestRedis(testRedisUrl);
  try {
    for (const bucket of buckets) await client.del(limiterKey(testApp, bucket));
  } finally {
    client.close();
  }
};

/**
 * Holds a fixed window open only if it is saturated: its real counter is
 * past `max` and its key is still there (PEXPIRE answers 0 for a key that
 * expired). A window that elapsed while a loaded machine was still setting
 * up reads as not saturated, so the caller saturates again instead of
 * holding open a window that never filled (ISSUE-281).
 */
export const holdOpenIfSaturated = async (
  testApp: TestApp,
  bucket: string,
  max: number,
  ms: number,
) => {
  const client = openTestRedis(testRedisUrl);
  try {
    const key = limiterKey(testApp, bucket);
    const count = Number((await client.get(key)) ?? 0);
    return (
      count > max && (await client.send('PEXPIRE', [key, String(ms)])) === 1
    );
  } finally {
    client.close();
  }
};

export const statuses = (responses: Response[]) =>
  responses.reduce<Record<number, number>>((tally, response) => {
    tally[response.status] = (tally[response.status] ?? 0) + 1;
    return tally;
  }, {});

/**
 * Second application instances beside a suite's own app: each has its own
 * SQL pool, Redis connection and auth, sharing the suite's configuration
 * and Redis namespace (the shared limiter state under test).
 */
export function createSecondInstances(testApp: TestApp) {
  const extraInstances: Array<() => Promise<void>> = [];
  const secondInstance = (
    overrides: {
      redisUrl?: string;
      limiter?: (
        base: ReturnType<typeof createAuthRateLimiter>,
      ) => Parameters<typeof createAuthServer>[0]['limiter'];
    } = {},
  ) => {
    const database = createDatabase({
      url: testDatabaseUrl as string,
    });
    const redis = createRedis({
      url: overrides.redisUrl ?? testRedisUrl,
      namespace: testApp.redisNamespace,
    });
    const base = createAuthRateLimiter(redis);
    const sent: string[] = [];
    const server = createAuthServer({
      config: readAuthConfig(testApp.env),
      database: database.authAdapter,
      emailSender: {
        send: async (message) => {
          sent.push(message.to);
        },
      },
      limiter: overrides.limiter ? overrides.limiter(base) : base,
      ledger: noLedger,
      appendSessionRevoked: async () => {},
      revokeOtherSessions: async () => 0,
      completeEmailChange: (input) => database.completeEmailChange(input),
      revokeSessionUnlessAddressHeld: (input) =>
        database.revokeSessionUnlessAddressHeld(input),
      logger: silentLogger,
      clock: systemClock,
      ids: systemId,
    });
    extraInstances.push(async () => {
      await database.close();
      redis.close();
    });
    return {
      sent,
      handlers: createAuthRouteHandlers(
        () => ({ handler: server.instance.handler, config: server.config }),
        silentLogger,
      ),
    };
  };
  const closeExtraInstances = async () => {
    for (const close of extraInstances.splice(0)) await close();
  };
  return { secondInstance, closeExtraInstances };
}
