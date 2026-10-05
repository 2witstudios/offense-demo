/**
 * Test-suite Redis support (ISSUE-237). Integration suites write to a
 * dedicated per-slot Redis database (ADR 0034) whose keys must never outlive
 * a run: every key carries an expiry, every namespace is a `t3-` one the
 * runner can sweep, and a killed run's leftovers are removed by the next run.
 */
import { RedisClient } from 'bun';
import { redisClientOptions } from './index';
import { isRegisteredScript } from './script-registry';
import type { RedisTransport } from './transport';

/** The prefix of every integration namespace; the runner sweeps by it. */
export const TEST_NAMESPACE_PREFIX = 't3-';

/** The longest an integration run may last, and how long a namespace may sit idle before the sweep takes it. */
export const TEST_RUN_MAX_MS = 60 * 60 * 1000;

/** Ceiling on any test key's remaining life: well past a run, so a crashed run's keys clear themselves. */
export const TEST_KEY_TTL_MAX_MS = 2 * TEST_RUN_MAX_MS;

/** A fresh test namespace from a cuid2 the caller injects. */
export const testNamespace = (id: string): string =>
  `${TEST_NAMESPACE_PREFIX}${id.slice(0, 10)}`;

/**
 * A TEST_REDIS_URL that `requireTestServices` (`@offense-demo/config`) accepted: this
 * slot's own database on its own server. Only such a URL opens a test client,
 * so an integration file cannot reach another database through these helpers.
 */
export type GuardedTestRedisUrl = string & { readonly ownTestRedis: true };

type Send = (command: string, args: string[]) => Promise<unknown>;

// Commands a test may send that create no key (reads, deletes) or that write
// or re-time the key they name first. Anything else is refused: the allowlist,
// not a list of bad names, is what keeps a test inside its namespace.
const reads = new Set([
  'DEL',
  'EXISTS',
  'GET',
  'GETDEL',
  'HGET',
  'HGETALL',
  'HMGET',
  'LLEN',
  'LRANGE',
  'MGET',
  'OBJECT',
  'PING',
  'PTTL',
  'SCARD',
  'SISMEMBER',
  'SMEMBERS',
  'STRLEN',
  'TIME',
  'TTL',
  'TYPE',
  'UNLINK',
  'ZCARD',
  'ZCOUNT',
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZREVRANGE',
  'ZSCORE',
]);
const writesFirstKey = new Set([
  'APPEND',
  'DECR',
  'DECRBY',
  'EXPIRE',
  'EXPIREAT',
  'GETEX',
  'GETSET',
  'HDEL',
  'HINCRBY',
  'HSET',
  'HSETNX',
  'INCR',
  'INCRBY',
  'LPUSH',
  'PERSIST',
  'PEXPIRE',
  'PEXPIREAT',
  'RPUSH',
  'SADD',
  'SET',
  'SETEX',
  'SETNX',
  'SREM',
  'ZADD',
  'ZINCRBY',
  'ZREM',
  'ZREMRANGEBYRANK',
  'ZREMRANGEBYSCORE',
]);

/**
 * The only shape of key pattern a test may scan or list by: a literal
 * `t3-` test namespace prefix with at least six literal id characters, then
 * anything. That names one test's namespace (ids are ten characters), so no
 * wildcard-only, character-class, short-prefix or empty pattern can match
 * beyond it, whatever it is spelled like.
 */
const namespaceAnchored = /^t3-[a-z0-9-]{6,}/;

/**
 * Every pattern a SCAN or KEYS would apply, or undefined when the arguments
 * are not ones Redis would parse as written. SCAN options are read in order
 * the way Redis reads them (`MATCH <pattern>`, `COUNT <n>`, `TYPE <t>`), so a
 * pattern cannot hide in another option's value, and every MATCH counts:
 * Redis applies the last one, so all of them must be anchored (ISSUE-269).
 */
function matchPatterns(
  command: string,
  args: readonly string[],
): string[] | undefined {
  if (command === 'KEYS')
    return args.length === 1 ? [String(args[0])] : undefined;
  const patterns: string[] = [];
  for (let at = 1; at < args.length; at += 2) {
    const option = String(args[at]).toUpperCase();
    const value = args[at + 1];
    if (value === undefined) return undefined;
    if (option === 'MATCH') patterns.push(String(value));
    else if (option !== 'COUNT' && option !== 'TYPE') return undefined;
  }
  return patterns;
}

/**
 * Why a test client refuses `command`, or undefined to send it. `scripts` is
 * true only for the wrapper handed to code under test, which may run the
 * adapter's registered scripts (`defineScript`) and nothing else: a test can
 * run no Lua, so no `redis.call('FLUSHDB')` reaches the server (ISSUE-274).
 */
export function commandRefusal(
  rawCommand: string,
  args: readonly string[],
  { scripts }: { readonly scripts: boolean },
): string | undefined {
  const command = String(rawCommand).toUpperCase();
  const refuse = (what: string) =>
    `Test Redis client refuses ${what}: a test reaches only its own namespace (packages/redis/src/testing.ts)`;
  if (command === 'SCAN' || command === 'KEYS')
    return scanRefusal(command, args, refuse);
  if (command === 'EVAL' || command === 'EVALSHA' || command === 'SCRIPT')
    return scriptRefusal(command, args, scripts, refuse);
  return reads.has(command) || writesFirstKey.has(command)
    ? undefined
    : refuse(command);
}

type Refuse = (what: string) => string;

/** A SCAN or KEYS is allowed only with every pattern anchored at one test namespace, and at least one. */
function scanRefusal(command: string, args: readonly string[], refuse: Refuse) {
  const patterns = matchPatterns(command, args);
  return patterns !== undefined &&
    patterns.length > 0 &&
    patterns.every((pattern) => namespaceAnchored.test(pattern))
    ? undefined
    : refuse(`${command} that is not anchored at one test namespace`);
}

/** Lua is for code under test, and only the adapter's registered scripts. */
function scriptRefusal(
  command: string,
  args: readonly string[],
  scripts: boolean,
  refuse: Refuse,
) {
  if (command === 'EVALSHA') return scripts ? undefined : refuse('EVALSHA');
  const registered =
    command === 'EVAL'
      ? isRegisteredScript(String(args[0]))
      : String(args[0]).toUpperCase() === 'LOAD' &&
        isRegisteredScript(String(args[1]));
  return scripts && registered
    ? undefined
    : refuse(`${command} of a script the adapter did not register`);
}

const expiryOptions = new Set(['EX', 'PX', 'EXAT', 'PXAT', 'KEEPTTL']);

// Caps each key's remaining life to ARGV[1]; a missing key (PTTL -2) is skipped.
const capScript = `
for i = 1, #KEYS do
  local ttl = redis.call('PTTL', KEYS[i])
  if ttl == -1 or ttl > tonumber(ARGV[1]) then
    redis.call('PEXPIRE', KEYS[i], ARGV[1])
  end
end
return #KEYS
`;

const cannotBound = (what: string): never => {
  throw new Error(
    `Test Redis client cannot bound the expiry of ${what}; use a command it knows (packages/redis/src/testing.ts)`,
  );
};

/** The keys a write command may have created or re-timed, or a refusal. */
function writtenKeys(command: string, args: readonly string[]): string[] {
  if (command === 'EVAL' || command === 'EVALSHA') {
    const count = Number(args[1]);
    if (!Number.isSafeInteger(count) || count < 0) return cannotBound(command);
    return args.slice(2, 2 + count);
  }
  const key = args[0];
  return key === undefined ? cannotBound(command) : [key];
}

/**
 * What a suite is handed instead of a Redis client (ISSUE-274): a frozen
 * object with no prototype, so it has no `constructor` to build a raw client
 * from, no `Symbol` or handle to reach the real one through, and only these
 * members, each of which is one guarded command.
 */
export interface TestRedis {
  send(command: string, args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<boolean>;
  pttl(key: string): Promise<number>;
  ping(): Promise<'PONG'>;
  connect(): Promise<void>;
  close(): void;
  readonly connected: boolean;
}

/**
 * Wraps a Redis client as a `TestRedis`: every command goes through
 * `commandRefusal` first, and with `maxTtlMs` no key it writes can be
 * immortal or outlive it (a SET with no expiry gets `PX maxTtlMs` in the same
 * command, every other write is followed by a one-script cap of the keys it
 * named, and a write whose keys cannot be attributed is refused).
 */
export function wrapTestRedis(
  inner: RedisTransport & { readonly connected?: boolean },
  {
    scripts,
    maxTtlMs,
  }: { readonly scripts: boolean; readonly maxTtlMs?: number },
): TestRedis {
  const raw: Send = (command, args) => inner.send(command, args);
  const send: Send = async (rawCommand, args) => {
    const refusal = commandRefusal(rawCommand, args, { scripts });
    if (refusal) throw new Error(refusal);
    const command = rawCommand.toUpperCase();
    if (maxTtlMs === undefined || !writesOrRuns(command))
      return raw(rawCommand, args);
    const keys = writtenKeys(command, args);
    const sent =
      command === 'SET' && !args.some((arg) => expiryOptions.has(arg))
        ? [...args, 'PX', String(maxTtlMs)]
        : args;
    // Issued back to back so both ride one round trip on the connection.
    const [reply] = await Promise.all([
      raw(rawCommand, sent),
      raw('EVAL', [capScript, String(keys.length), ...keys, String(maxTtlMs)]),
    ]);
    return reply;
  };
  const wrapper = Object.create(null) as Record<string, unknown>;
  Object.assign(wrapper, {
    send,
    get: async (key: string) => (await send('GET', [key])) as string | null,
    getdel: async (key: string) =>
      (await send('GETDEL', [key])) as string | null,
    del: async (key: string) => Number(await send('DEL', [key])),
    exists: async (key: string) => Number(await send('EXISTS', [key])) > 0,
    pttl: async (key: string) => Number(await send('PTTL', [key])),
    ping: async () => String(await send('PING', [])) as 'PONG',
    connect: () => inner.connect(),
    close: () => inner.close(),
  });
  Object.defineProperty(wrapper, 'connected', {
    enumerable: true,
    get: () => inner.connected === true,
  });
  return Object.freeze(wrapper) as unknown as TestRedis;
}

// Whether a command may create or re-time a key (so a bounded client caps it).
const writesOrRuns = (command: string): boolean =>
  command === 'EVAL' || command === 'EVALSHA' || writesFirstKey.has(command);

/** The one way an integration file opens Redis: a `TestRedis` on the slot's own database, with no raw client behind it. */
export const openTestRedis = (url: GuardedTestRedisUrl): TestRedis =>
  wrapTestRedis(new RedisClient(url), { scripts: false });

/** What a suite hands to the code under test: the adapter's dialing options, expiry bounded, and only the adapter's own scripts. */
export const createBoundedTestClient = (
  url: GuardedTestRedisUrl,
  maxTtlMs: number = TEST_KEY_TTL_MAX_MS,
): TestRedis =>
  wrapTestRedis(new RedisClient(url, redisClientOptions), {
    scripts: true,
    maxTtlMs,
  });
