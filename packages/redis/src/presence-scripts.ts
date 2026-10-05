import { defineScript } from './script-registry';
import type { RedisTransport } from './transport';
import { idSchema, presenceActivitySchema } from '@offense-demo/protocol';
import type { PresenceActivity } from '@offense-demo/protocol';
import { redisSegmentPattern } from './redis-key';

/**
 * Every script reads `now` from Redis TIME rather than an argument: scores,
 * trims and the key TTLs below all come from the one server clock, so no
 * instance clock is ever compared with another.
 */
const nowFromTime = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
`;
/**
 * Sets (or extends) KEYS[2]/KEYS[3]'s own expiry to cover the longest live
 * lease scored into them: NX arms it the first time a key is created, GT
 * only ever extends it, so it tracks the longest lease ever seen and never
 * shortens under a later, shorter-lived write. Requires `top` (a
 * ZREVRANGE ... WITHSCORES result) and `now` in scope.
 */
const armZsetExpiry = `
local function arm(key, top, now)
  if top[2] then
    local ttl = tonumber(top[2]) - now
    if ttl < 1 then ttl = 1 end
    redis.call('PEXPIRE', key, ttl, 'NX')
    redis.call('PEXPIRE', key, ttl, 'GT')
  end
end
`;
/**
 * Sets the connection hash with its own TTL, scores the connId into the
 * user's zset by expiry, then rescores the user into the online zset by
 * its live connections' latest expiry. One EVAL, so a concurrent reader
 * never observes the hash without its zset entries or vice versa. The
 * user and online zsets each get their own expiry covering the longest
 * live lease, so neither key can outlive every lease scored into it. The
 * user zset's lapsed members are trimmed here, on the write path, so the
 * read never has to (and a reconnecting user's zset stays small).
 * KEYS[1] conn hash; KEYS[2] user zset; KEYS[3] online zset.
 * ARGV[1] userId; ARGV[2] activity; ARGV[3] instanceId; ARGV[4] ttlMs;
 * ARGV[5] connId.
 */
export const upsertPresenceLeaseScript = defineScript(`
${nowFromTime}
${armZsetExpiry}
local expiresAt = now + tonumber(ARGV[4])
redis.call('HSET', KEYS[1], 'userId', ARGV[1], 'activity', ARGV[2], 'instanceId', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 1)
redis.call('ZADD', KEYS[2], expiresAt, ARGV[5])
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
arm(KEYS[2], top, now)
if top[2] then
  redis.call('ZADD', KEYS[3], top[2], ARGV[1])
  arm(KEYS[3], top, now)
end
return 1
`);
/**
 * Extends the connection's TTL and rescores it, but only if the lease is
 * still live: a lease whose hash already expired must be re-upserted, not
 * silently resurrected by refresh. Trims the user zset's lapsed members
 * like the upsert. KEYS[1] conn hash; KEYS[2] user zset;
 * KEYS[3] online zset. ARGV[1] ttlMs; ARGV[2] connId; ARGV[3] userId.
 */
export const refreshPresenceLeaseScript = defineScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
${nowFromTime}
${armZsetExpiry}
local expiresAt = now + tonumber(ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 1)
redis.call('ZADD', KEYS[2], expiresAt, ARGV[2])
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
arm(KEYS[2], top, now)
if top[2] then
  redis.call('ZADD', KEYS[3], top[2], ARGV[3])
  arm(KEYS[3], top, now)
end
return 1
`);
/**
 * Deletes the connection hash immediately (a clean disconnect), drops it
 * from the user's zset, then rescores or removes the user from the
 * online zset depending on whether any connection remains. Trims stale
 * (past-scored) members from the user zset before reading its top, so a
 * connId that already lapsed without ever being read can never masquerade
 * as the new top and get propagated into the online zset with a stale
 * score. Whenever a live top remains, both zsets are (re)armed: a prior
 * write's trim or sweep can empty and drop either key entirely between calls, and a
 * bare ZADD onto a dropped key recreates it with no TTL, so this script
 * cannot assume either key's expiry is still intact just because it was
 * armed once. KEYS[1] conn hash; KEYS[2] user zset; KEYS[3] online zset.
 * ARGV[1] connId; ARGV[2] userId.
 */
export const deletePresenceLeaseScript = defineScript(`
${nowFromTime}
${armZsetExpiry}
local existed = redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - 1)
local top = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
if top[2] then
  redis.call('ZADD', KEYS[3], top[2], ARGV[2])
  -- No-op today (upsert/refresh arm on write); kept as defence in depth for
  -- future write paths.
  arm(KEYS[2], top, now)
  arm(KEYS[3], top, now)
else
  redis.call('ZREM', KEYS[3], ARGV[2])
end
return existed
`);
/**
 * One atomic, read-only op: range at most ARGV[3] of the user's members
 * whose score (lease expiry) is not in the past, latest expiry first,
 * hydrate each from its connection hash, and drop any whose hash is already
 * gone (a benign race between the two keys) or whose hash names a different
 * user than the one requested (the zset is scoped per user, so this should
 * never happen with server-minted ids, but the read never trusts it).
 * Lapsed members are filtered by the score range, never deleted: reads must
 * not mutate state, and the upsert, refresh and delete scripts trim them on
 * the write path. Returns the Redis `now` it used as the first element,
 * so a caller never substitutes an instance clock for the server clock
 * that scored these leases. KEYS[1] user zset. ARGV[1] userId; ARGV[2]
 * the conn-hash key prefix (namespace-qualified, no trailing connId);
 * ARGV[3] the most connections to return.
 *
 * Connection hash keys are built inside the script from ARGV[2] .. connId
 * rather than declared through KEYS: the member count is not known until
 * the zset is read, so the key list cannot be sized ahead of the call. This
 * is safe only because deployment is single-node (ADR 0008: the native Bun
 * `RedisClient` has no Cluster/Sentinel support, so cross-slot KEYS
 * declarations are never required); a Cluster deployment would need this
 * redesigned around hash tags. See this package's README.
 */
export const readUserConnectionsScript = defineScript(`
${nowFromTime}
local members = redis.call('ZREVRANGEBYSCORE', KEYS[1], '+inf', now, 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[3]))
local result = {now}
for i = 1, #members, 2 do
  local connId = members[i]
  local expiresAt = members[i + 1]
  local hash = redis.call('HGETALL', ARGV[2] .. connId)
  if #hash > 0 then
    local record = {}
    for j = 1, #hash, 2 do record[hash[j]] = hash[j + 1] end
    if record.userId == ARGV[1] then
      table.insert(result, connId)
      table.insert(result, record.userId)
      table.insert(result, record.activity)
      table.insert(result, record.instanceId)
      table.insert(result, expiresAt)
    end
  end
end
return result
`);
/**
 * A read-only, bounded range of the online set: users whose latest lease
 * has not expired, ranged by score with a caller-supplied LIMIT, no write.
 * `online` is a single global key, so an unbounded read here would scale
 * with every user ever online; the bound keeps this op cheap regardless of
 * how many are online at once. Expired members are filtered by the score
 * range (`now` .. `+inf`), never deleted: reads must not mutate state, so
 * trimming lapsed members off this key is `sweepOnlinePresence`'s job, not
 * this one's. Returns the Redis `now` it used as the first element, so a
 * caller never substitutes an instance clock for the server clock that
 * scored these leases. KEYS[1] online zset. ARGV[1] limit.
 */
export const readOnlinePresenceScript = defineScript(`
${nowFromTime}
local members = redis.call('ZRANGEBYSCORE', KEYS[1], now, '+inf', 'WITHSCORES', 'LIMIT', 0, tonumber(ARGV[1]))
local result = {now}
for i = 1, #members do
  table.insert(result, members[i])
end
return result
`);
/**
 * A bounded write-path sweep: removes up to ARGV[1] members of the online
 * set whose score is in the past. Trimming moved here, off the read path
 * (`readOnlinePresenceScript`), so a read never mutates state; the web
 * retention sweep runs this on its schedule instead. `unpack`
 * passes every expired member to one ZREM, and Lua refuses to unpack more
 * than about 8,000 values, so `assertLimit` caps ARGV[1] at
 * `PRESENCE_LIMIT_MAX`, far below that. Returns the number of members
 * removed. KEYS[1] online zset. ARGV[1] limit.
 */
export const sweepOnlinePresenceScript = defineScript(`
${nowFromTime}
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now - 1, 'LIMIT', 0, tonumber(ARGV[1]))
if #expired > 0 then
  redis.call('ZREM', KEYS[1], unpack(expired))
end
return #expired
`);

/** connId and instanceId are server-minted identifiers, not user ids: they only need to be safe Redis key segments. */
export function assertKeySegment(label: string, value: string) {
  if (!redisSegmentPattern.test(value)) throw new Error(`Invalid ${label}`);
}
export function assertUserId(userId: string): asserts userId is string {
  if (!idSchema.safeParse(userId).success) throw new Error('Invalid userId');
}
export function parseActivity(value: string): PresenceActivity {
  const parsed = presenceActivitySchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid activity');
  return parsed.data;
}
export function assertTtlSeconds(ttlSeconds: number) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
    throw new Error('TTL must be a positive integer');
}
/**
 * The most members one presence read or sweep may range. Bounds each
 * script's work and reply, and keeps the sweep's `unpack` well under Lua's
 * limit (ISSUE-46).
 */
export const PRESENCE_LIMIT_MAX = 1000;
/** The most live connections `readUserConnections` returns for one user. */
export const USER_CONNECTIONS_MAX = 32;
export function assertLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PRESENCE_LIMIT_MAX)
    throw new Error(
      `Limit must be a positive integer no greater than ${PRESENCE_LIMIT_MAX}`,
    );
}

/**
 * Loads each script once and runs it by SHA1 with EVALSHA, reloading and
 * retrying exactly once on NOSCRIPT (the server evicted it, e.g. after a
 * restart or `SCRIPT FLUSH`). Avoids resending the full script text on
 * every call. One cache per `createScriptRunner` call, keyed by script
 * source.
 */
export function createScriptRunner(client: RedisTransport) {
  const shaByScript = new Map<string, string>();
  async function load(script: string): Promise<string> {
    const sha = (await client.send('SCRIPT', ['LOAD', script])) as string;
    shaByScript.set(script, sha);
    return sha;
  }
  return async function run(
    script: string,
    numkeys: number,
    keysAndArgs: readonly string[],
  ): Promise<unknown> {
    const sha = shaByScript.get(script) ?? (await load(script));
    try {
      return await client.send('EVALSHA', [
        sha,
        String(numkeys),
        ...keysAndArgs,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('NOSCRIPT')) {
        const reloaded = await load(script);
        return await client.send('EVALSHA', [
          reloaded,
          String(numkeys),
          ...keysAndArgs,
        ]);
      }
      throw error;
    }
  };
}
