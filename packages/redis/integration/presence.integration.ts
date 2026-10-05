import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { lease, withRedis } from './test-support';

setupRitewayBun();

const { redisUrl: url } = requireTestServices(process.env);

/**
 * A lease's remaining life in whole tens of seconds, read against the Redis
 * server clock the same read used: scores are server time, so the only
 * slack is the latency between the write and the read, far under 5 s.
 */
const leaseSeconds = (expiresAtMs: number, nowMs: number) =>
  Math.round((expiresAtMs - nowMs) / 10_000) * 10;

test('presence lease upsert, refresh and delete are visible through the reads', () =>
  withRedis(url, async ({ redis }) => {
    const userId = createId();
    const connections = async () => {
      const { connections: found, nowMs } =
        await redis.readUserConnections(userId);
      return found
        .map(({ connId, activity, instanceId, expiresAtMs }) => ({
          connId,
          activity,
          instanceId,
          lease: leaseSeconds(expiresAtMs, nowMs),
        }))
        .sort((a, b) => a.connId.localeCompare(b.connId));
    };
    const online = async () => {
      const { users, nowMs } = await redis.readOnlinePresence(100);
      return users.map((user) => ({
        userId: user.userId,
        lease: leaseSeconds(user.expiresAtMs, nowMs),
      }));
    };

    await redis.upsertPresenceLease(
      lease('connA1', userId, 'active', 'instX'),
      60,
    );
    await redis.upsertPresenceLease(
      lease('connA2', userId, 'idle', 'instY'),
      120,
    );
    assert({
      given: 'two connections from one user with 60 s and 120 s leases',
      should:
        'score each connection independently and the user online by its longest lease',
      actual: { connections: await connections(), online: await online() },
      expected: {
        connections: [
          {
            connId: 'connA1',
            activity: 'active',
            instanceId: 'instX',
            lease: 60,
          },
          {
            connId: 'connA2',
            activity: 'idle',
            instanceId: 'instY',
            lease: 120,
          },
        ],
        online: [{ userId, lease: 120 }],
      },
    });

    const refreshed = await redis.refreshPresenceLease(
      { connId: 'connA1', userId },
      90,
    );
    await redis.deletePresenceLease({ connId: 'connA2', userId });
    assert({
      given: 'connA1 refreshed to 90 s, then connA2 deleted',
      should:
        'report the refresh and fall the online score back to the remaining lease',
      actual: {
        refreshed,
        connections: await connections(),
        online: await online(),
      },
      expected: {
        refreshed: { refreshed: true },
        connections: [
          {
            connId: 'connA1',
            activity: 'active',
            instanceId: 'instX',
            lease: 90,
          },
        ],
        online: [{ userId, lease: 90 }],
      },
    });

    await redis.deletePresenceLease({ connId: 'connA1', userId });
    assert({
      given: 'the last connection deleted',
      should: 'leave no connection and drop the user from the online set',
      actual: { connections: await connections(), online: await online() },
      expected: { connections: [], online: [] },
    });
  }));

test('the user and online zsets carry a mandatory expiry covering the longest live lease, never PTTL -1', () =>
  withRedis(url, async ({ redis, raw, key }) => {
    const userId = createId();
    await redis.upsertPresenceLease(lease('connX', userId), 60);
    const keys = [
      key('presence', 'conn', 'connX'),
      key('presence', 'user', userId),
      key('presence', 'online'),
    ];
    const pttls = await Promise.all(keys.map((name) => raw.pttl(name)));
    assert({
      given: 'a 60 s lease',
      should:
        'give the conn hash, the user zset and the online zset each an expiry within 60 s (-1 would mean unbounded growth)',
      actual: pttls.map((pttl) => pttl > 0 && pttl <= 60_000),
      expected: [true, true, true],
    });
  }));

test('refreshing with a longer TTL extends both the user and online zset expiries (PEXPIRE ... GT), not just arms them once', () =>
  // Without GT a second PEXPIRE on an already-expiring key is a no-op, so
  // either zset would keep the first 5 s expiry; a mutation deleting the
  // refresh script's online `arm` survived when only the user zset was
  // checked, so both are asserted.
  withRedis(url, async ({ redis, raw, key }) => {
    const userId = createId();
    await redis.upsertPresenceLease(lease('connG', userId), 5);
    await redis.refreshPresenceLease({ connId: 'connG', userId }, 100);
    assert({
      given: 'a 5 s lease refreshed to 100 s',
      should: 'extend both zset expiries beyond the first 5 s',
      actual: {
        user: (await raw.pttl(key('presence', 'user', userId))) > 5_000,
        online: (await raw.pttl(key('presence', 'online'))) > 5_000,
      },
      expected: { user: true, online: true },
    });
  }));

test('a delete arms a fresh expiry when it recreates a dropped online zset from a genuinely live remaining connection', () =>
  // The online key is dropped directly (as an earlier trim would), and
  // deleting the OTHER connection must recreate it with a bounded expiry.
  withRedis(url, async ({ redis, raw, key }) => {
    const userId = createId();
    const onlineKey = key('presence', 'online');
    await redis.upsertPresenceLease(lease('staying', userId), 100);
    await redis.upsertPresenceLease(
      lease('leaving', userId, 'active', 'inst2'),
      100,
    );
    await raw.del(onlineKey);
    await redis.deletePresenceLease({ connId: 'leaving', userId });
    assert({
      given: 'a delete beside a live lease after the online key was dropped',
      should: 'put the user back online on a key that expires',
      actual: {
        online: (await redis.readOnlinePresence(100)).users.map(
          (user) => user.userId,
        ),
        expires: (await raw.pttl(onlineKey)) > 0,
      },
      expected: { online: [userId], expires: true },
    });
  }));

test('the online score always reflects the user’s longest live lease, not the most recently upserted one', () =>
  // Negative control for a reviewer's mutation (scoring online by the
  // just-upserted lease): the longer lease is written FIRST here.
  withRedis(url, async ({ redis }) => {
    const userId = createId();
    await redis.upsertPresenceLease(lease('longConn', userId), 120);
    await redis.upsertPresenceLease(
      lease('shortConn', userId, 'active', 'inst2'),
      5,
    );
    const { users, nowMs } = await redis.readOnlinePresence(100);
    assert({
      given: 'a 120 s lease followed by a 5 s lease',
      should: 'keep the user online on the 120 s lease',
      actual: users.map((user) => leaseSeconds(user.expiresAtMs, nowMs)),
      expected: [120],
    });
  }));

test('both reads return the Redis server clock they used, never requiring an instance clock', () =>
  withRedis(url, async ({ redis, serverNowMs }) => {
    const userId = createId();
    await redis.upsertPresenceLease(lease('connNow', userId), 60);
    const before = await serverNowMs();
    const { nowMs: userNowMs } = await redis.readUserConnections(userId);
    const { nowMs: onlineNowMs } = await redis.readOnlinePresence(100);
    const after = await serverNowMs();
    assert({
      given: 'both reads bracketed by Redis TIME calls',
      should: 'report a server time between the two brackets',
      actual: [userNowMs, onlineNowMs].map(
        (nowMs) => nowMs >= before && nowMs <= after,
      ),
      expected: [true, true],
    });
  }));
