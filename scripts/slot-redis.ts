/**
 * The Redis database each slot's integration suites use (ADR 0034, ISSUE-237).
 * Integration suites write to a Redis database of the slot's own, so a run's
 * SCANs and teardown never walk another slot's keys. Main keeps database 1
 * (CI's too); worktree block n owns database 2 + n, above dev (0), main's
 * test (1) and the browser suite's (2). Blocks are 1..499, so the shared
 * Redis needs `--databases 512` (infra/compose.yaml).
 */

import { RedisClient } from 'bun';
import {
  expectedTestRedisDatabase,
  testRedisDatabase,
  testRedisRefusal,
} from '@offense-demo/config';
import {
  deleteNamespace,
  listNamespaces,
} from '@offense-demo/redis/namespaces';
import { TEST_NAMESPACE_PREFIX } from '@offense-demo/redis/testing';

type Commands = {
  readonly send: (command: string, args: string[]) => Promise<unknown>;
};

/** How many databases the Redis server must offer for that block's test database. */
export const redisDatabasesNeeded = (block?: number): number =>
  testRedisDatabase(block) + 1;

/**
 * The value of one `CONFIG GET <name>` reply. Redis answers RESP3 with a map
 * and RESP2 with a flat [name, value] list; Bun surfaces them as an object
 * or an array.
 */
export function configValue(reply: unknown, name: string): string | undefined {
  const value = Array.isArray(reply)
    ? reply[reply.indexOf(name) + 1]
    : reply instanceof Map
      ? reply.get(name)
      : (reply as Record<string, unknown> | null)?.[name];
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Why a Redis server cannot host this slot's test database, or undefined.
 * `databases` is fixed when Redis starts, so a shared Redis started before
 * ISSUE-237 (16 databases) is recreated once by the operator, never by
 * slot:up, which must not restart the stack under every checkout.
 */
export function redisDatabaseRefusal({
  available,
  block,
}: {
  readonly available: number;
  readonly block?: number;
}): string | undefined {
  const needed = redisDatabasesNeeded(block);
  return available >= needed
    ? undefined
    : `The shared Redis offers ${available} databases but this slot's test database is ${testRedisDatabase(block)} (port block ${block}); it needs ${needed}. Recreate Redis once with 'docker compose -f infra/compose.yaml up -d --force-recreate redis' (infra/compose.yaml starts it with --databases 512; its keys are expendable, but every checkout's Redis sessions and counters are lost), then run bun slot:up again.`;
}

/** Throws the refusal, if any, after asking the server how many databases it offers. */
export async function requireRedisDatabases(
  client: Commands,
  block?: number,
): Promise<void> {
  const offered = configValue(
    await client.send('CONFIG', ['GET', 'databases']),
    'databases',
  );
  const refusal = redisDatabaseRefusal({
    available: Number(offered ?? 0),
    ...(block === undefined ? {} : { block }),
  });
  if (refusal) throw new Error(refusal);
}

/**
 * The client slot:down clears the test database with (it refuses main): one
 * on the worktree's own database, and only that. Any other database, shared
 * or another slot's, gets undefined, so slot:down never deletes another
 * checkout's keys.
 */
export const openOwnTestRedis = (env: {
  readonly TEST_REDIS_URL?: string | undefined;
  readonly REDIS_URL?: string | undefined;
  readonly PORT?: string | undefined;
}): RedisClient | undefined =>
  env.TEST_REDIS_URL !== undefined &&
  testRedisRefusal({
    testRedisUrl: env.TEST_REDIS_URL,
    redisUrl: env.REDIS_URL,
    expected: expectedTestRedisDatabase(env.PORT, 'worktree'),
  }) === undefined
    ? new RedisClient(env.TEST_REDIS_URL)
    : undefined;

/** slot:down's release of a slot's test database: every `t3-` namespace a run left, by SCAN and UNLINK. */
export async function clearTestNamespaces(
  client: Commands | undefined,
): Promise<number> {
  if (!client) return 0;
  let removed = 0;
  for (const namespace of await listNamespaces(client, TEST_NAMESPACE_PREFIX))
    removed += await deleteNamespace(client, namespace);
  return removed;
}
