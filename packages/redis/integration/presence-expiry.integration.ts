import { expect } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { lease, withRedis } from './test-support';

setupRitewayBun();

const { redisUrl: url } = requireTestServices(process.env);

test('readUserConnections omits members scored in the past, one at a time, without deleting them', () =>
  // Simulates a crashed instance whose leases were never refreshed: each
  // connId's score is rewritten through a raw client to a point relative to
  // the Redis server clock, so the filter is proven by the scores alone. The
  // hashes carry a long TTL throughout, so a read that omits a member must
  // have done so by its score, not because the hash disappeared. The read
  // never writes (ISSUE-46): the lapsed members are still stored afterwards,
  // so putting a ZREMRANGEBYSCORE back into the read fails this test.
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const userId = createId();
    const userKey = key('presence', 'user', userId);
    for (const connId of ['shortLease', 'midLease', 'longLease'])
      await redis.upsertPresenceLease(lease(connId, userId), 100);
    const now = await serverNowMs();
    await raw.send('ZADD', [userKey, String(now - 10_000), 'shortLease']);
    await raw.send('ZADD', [userKey, String(now + 100_000), 'midLease']);
    await raw.send('ZADD', [userKey, String(now + 100_000), 'longLease']);
    const connIds = async () =>
      (await redis.readUserConnections(userId)).connections
        .map((connection) => connection.connId)
        .sort();

    assert({
      given: 'one lapsed lease among three',
      should: 'return only the two live connections',
      actual: await connIds(),
      expected: ['longLease', 'midLease'],
    });
    await raw.send('ZADD', [userKey, String(now - 10_000), 'midLease']);
    assert({
      given: 'a second lease lapsing afterwards',
      should:
        'omit only that member, one at a time, and leave both lapsed members stored',
      actual: {
        connections: await connIds(),
        shortStored:
          (await raw.send('ZSCORE', [userKey, 'shortLease'])) !== null,
        midStored: (await raw.send('ZSCORE', [userKey, 'midLease'])) !== null,
      },
      expected: {
        connections: ['longLease'],
        shortStored: true,
        midStored: true,
      },
    });
    // The next write for this user trims both lapsed members.
    await redis.refreshPresenceLease({ connId: 'longLease', userId }, 100);
    assert({
      given: 'a refresh of the live lease',
      should: 'trim both lapsed members from the user zset',
      actual: await raw.send('ZRANGE', [userKey, '0', '-1']),
      expected: ['longLease'],
    });
  }));

test('readOnlinePresence never returns a user scored in the past', () =>
  // readOnlinePresence is a pure read (bounded ZRANGEBYSCORE, no ZREM), so a
  // ghost's stale member is filtered by score, not deleted; the sweep test
  // in presence-bounds.integration.ts proves the removal.
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const liveUserId = createId();
    await redis.upsertPresenceLease(lease('liveConn', liveUserId), 100);
    await raw.send('ZADD', [
      key('presence', 'online'),
      String((await serverNowMs()) - 5_000),
      createId(),
    ]);
    assert({
      given: 'a live user and a ghost scored five seconds in the past',
      should: 'list only the live user',
      actual: (await redis.readOnlinePresence(100)).users.map(
        (user) => user.userId,
      ),
      expected: [liveUserId],
    });
  }));

test('a lease is a real Redis TTL: the hash physically disappears without a delete', () =>
  // Proves the mandatory TTL is a genuine server-side expiry, not only our
  // own read trim: the hash carries a PTTL within the lease (removing the
  // PEXPIRE in the write script fails that), and once Redis fires that
  // expiry the hash is gone with no delete from us.
  withRedis(url, async ({ redis, raw, key, expireNow }) => {
    const userId = createId();
    const connKey = key('presence', 'conn', 'ttlConn');
    await redis.upsertPresenceLease(lease('ttlConn', userId), 3);
    const pttl = await raw.pttl(connKey);
    const connIds = async () =>
      (await redis.readUserConnections(userId)).connections.map(
        (connection) => connection.connId,
      );
    assert({
      given: 'a fresh three-second lease',
      should: 'store the hash with a server-side expiry of at most 3 s',
      actual: {
        exists: await raw.exists(connKey),
        expiryWithinLease: pttl > 0 && pttl <= 3_000,
        connections: await connIds(),
      },
      expected: {
        exists: true,
        expiryWithinLease: true,
        connections: ['ttlConn'],
      },
    });
    await expireNow(connKey);
    assert({
      given: 'the lease expiry firing',
      should: 'remove the hash, and the read returns no connection',
      actual: {
        exists: await raw.exists(connKey),
        connections: await connIds(),
      },
      expected: { exists: false, connections: [] },
    });
  }));

test('refresh on an already-expired lease reports refreshed: false rather than reviving it', () =>
  withRedis(url, async ({ redis, key, expireNow }) => {
    const userId = createId();
    await redis.upsertPresenceLease(lease('staleConn', userId), 3);
    await expireNow(key('presence', 'conn', 'staleConn'));
    assert({
      given: 'a refresh after the lease expired',
      should: 'report refreshed: false and not resurrect the hash',
      actual: {
        result: await redis.refreshPresenceLease(
          { connId: 'staleConn', userId },
          60,
        ),
        connections: (await redis.readUserConnections(userId)).connections,
      },
      expected: { result: { refreshed: false }, connections: [] },
    });
  }));

test('readUserConnections drops a record whose hash names a different user than requested', () =>
  // The read must not trust the zset alone: it checks the hydrated hash's
  // own userId field before returning a record.
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const p1 = createId();
    const p2 = createId();
    await redis.upsertPresenceLease(lease('shared', p2), 60);
    // Score p2's connId into p1's user zset too: a corrupt cross-reference.
    await raw.send('ZADD', [
      key('presence', 'user', p1),
      String((await serverNowMs()) + 60_000),
      'shared',
    ]);
    const connIds = async (userId: string) =>
      (await redis.readUserConnections(userId)).connections.map(
        (connection) => connection.connId,
      );
    assert({
      given: "another user's connId scored into this user's zset",
      should: 'drop it for this user and keep it for its owner',
      actual: { p1: await connIds(p1), p2: await connIds(p2) },
      expected: { p1: [], p2: ['shared'] },
    });
  }));

test('a delete never propagates a stale leftover member into the online zset', () =>
  // staleConn lapses without ever being read, so its past-scored member is
  // still in the user zset. Deleting the OTHER, live connection must not
  // read that leftover as the new "top" and ZADD it back into the online
  // zset. neighborConn keeps the online key itself alive, so the ZSCORE
  // oracle below cannot race a physical expiry of that key.
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const userId = createId();
    const userKey = key('presence', 'user', userId);
    const onlineKey = key('presence', 'online');
    await redis.upsertPresenceLease(lease('neighborConn', createId()), 100);
    await redis.upsertPresenceLease(lease('longConn', userId), 100);
    await redis.upsertPresenceLease(lease('staleConn', userId), 100);
    await raw.send('ZADD', [
      userKey,
      String((await serverNowMs()) - 10_000),
      'staleConn',
    ]);
    await raw.del(key('presence', 'conn', 'staleConn'));

    await redis.deletePresenceLease({ connId: 'longConn', userId });

    assert({
      given: 'a delete of the live lease beside a lapsed, unread one',
      should:
        'leave no member for the user online and drop the emptied user zset',
      actual: {
        onlineScore: await raw.send('ZSCORE', [onlineKey, userId]),
        listed: (await redis.readOnlinePresence(100)).users.some(
          (user) => user.userId === userId,
        ),
        userZset: await raw.exists(userKey),
      },
      expected: { onlineScore: null, listed: false, userZset: false },
    });
  }));

test('presence reads and writes reject invalid ids, activity and TTLs before touching Redis', () =>
  withRedis(url, async ({ redis }) => {
    const userId = createId();
    await expect(redis.readUserConnections('not a valid id!')).rejects.toThrow(
      'Invalid userId',
    );
    await expect(
      redis.upsertPresenceLease(lease('ok', userId), 0),
    ).rejects.toThrow('TTL must be a positive integer');
    await expect(
      redis.upsertPresenceLease(
        // @ts-expect-error deliberately invalid at the runtime boundary
        { ...lease('ok', userId), activity: 'sleeping' },
        60,
      ),
    ).rejects.toThrow('Invalid activity');
  }));
