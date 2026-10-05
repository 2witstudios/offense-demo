/**
 * Which Redis an integration run may touch (ADR 0034, ISSUE-244, ISSUE-245).
 * Every path that writes or deletes test keys (the suites, the runner's sweep
 * and post-run scan, slot:down) first checks that TEST_REDIS_URL is exactly
 * this slot's own database on this slot's own Redis server, so a hand-edited
 * `.env`, or a file run directly, can never reach another slot's, dev's or
 * e2e's keys, or another server's.
 */

const mainTestRedisDatabase = 1;
const worktreeTestRedisDatabaseBase = 2;
// Worktree port block n (1..499) owns app port 13000 + 10n (slot-model.ts).
const portBlockBase = 13_000;
const portBlockSize = 10;
const maxPortBlock = 499;

/** The Redis database a slot's integration suites use (`undefined` block: main). */
export const testRedisDatabase = (block?: number): number =>
  block === undefined
    ? mainTestRedisDatabase
    : worktreeTestRedisDatabaseBase + block;

/**
 * The test database this slot owns, from the PORT `slot:up` wrote: main
 * (3000, or no PORT as in CI) is 1, worktree port block n is 2 + n; any
 * other PORT names no block. `kind` is inferred when omitted.
 */
export function expectedTestRedisDatabase(
  port: string | undefined,
  kind: 'main' | 'worktree' | undefined = port === undefined || port === '3000'
    ? 'main'
    : 'worktree',
): number | undefined {
  if (kind === 'main') return testRedisDatabase();
  const block = (Number(port) - portBlockBase) / portBlockSize;
  return Number.isInteger(block) && block >= 1 && block <= maxPortBlock
    ? testRedisDatabase(block)
    : undefined;
}

const databaseIndex = (url: URL): number | string => {
  const path = url.pathname.slice(1);
  if (path === '') return 0;
  return /^(?:0|[1-9][0-9]*)$/.test(path) ? Number(path) : path;
};

const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Host and port with every spelling of this machine and the default port made equal. */
const serverOf = (url: URL): string =>
  `${loopback.has(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase()}:${url.port || '6379'}`;

const parsed = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * Why `testRedisUrl` is not this slot's own test database on this slot's own
 * server, or undefined when it is. `redisUrl` (REDIS_URL) names the slot's
 * shared server; the URL's path alone selects the database, as it does in
 * Bun. Messages name database numbers, never a URL, host or credential.
 */
export function testRedisRefusal({
  testRedisUrl,
  redisUrl,
  expected,
}: {
  readonly testRedisUrl: string | undefined;
  readonly redisUrl: string | undefined;
  readonly expected: number | undefined;
}): string | undefined {
  const test = testRedisUrl === undefined ? undefined : parsed(testRedisUrl);
  if (test === undefined) return 'TEST_REDIS_URL is unset';
  if (expected === undefined)
    return "PORT does not name this slot's port block, so its test Redis database cannot be derived (run bun slot:up)";
  const actual = databaseIndex(test);
  if (actual !== expected)
    return `TEST_REDIS_URL names Redis database ${actual}, expected this slot's own database ${expected} (run bun slot:up)`;
  const slot = redisUrl === undefined ? undefined : parsed(redisUrl);
  if (slot === undefined)
    return "REDIS_URL is unset, so this slot's Redis server cannot be told from another (run bun slot:up)";
  return serverOf(test) === serverOf(slot)
    ? undefined
    : "TEST_REDIS_URL names a different Redis server than REDIS_URL, expected this slot's shared Redis (run bun slot:up)";
}

/** A TEST_REDIS_URL that passed `testRedisRefusal`: the only kind `openTestRedis` accepts. */
export type OwnTestRedisUrl = string & { readonly ownTestRedis: true };
