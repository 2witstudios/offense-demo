import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import {
  USER_CONNECTIONS_MAX,
  PRESENCE_LIMIT_MAX,
} from '../src/presence-scripts';
import { lease, withRedis } from './test-support';

setupRitewayBun();

const { redisUrl: url } = requireTestServices(process.env);

/**
 * ISSUE-46: every presence read is bounded and read-only, and the online
 * sweep is bounded by the limit cap.
 */
test('readOnlinePresence bounds its result to the given limit', () =>
  withRedis(url, async ({ redis }) => {
    for (const [index, userId] of [
      createId(),
      createId(),
      createId(),
    ].entries())
      await redis.upsertPresenceLease(lease(`bound${index}`, userId), 60);
    assert({
      given: 'three online users and a limit of 2',
      should: 'return two users',
      actual: (await redis.readOnlinePresence(2)).users.length,
      expected: 2,
    });
  }));

test('readOnlinePresence never writes: an expired online member is still stored after a read', () =>
  // The negative control for ISSUE-46: putting ZREMRANGEBYSCORE back into
  // readOnlinePresenceScript deletes the ghost below and fails this test.
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const liveUserId = createId();
    const ghostUserId = createId();
    const onlineKey = key('presence', 'online');
    const ghostScore = (await serverNowMs()) - 5_000;
    await redis.upsertPresenceLease(lease('liveConn', liveUserId), 100);
    await raw.send('ZADD', [onlineKey, String(ghostScore), ghostUserId]);
    assert({
      given: 'a live user and a ghost scored in the past',
      should: 'list only the live user and leave the ghost stored',
      actual: {
        online: (await redis.readOnlinePresence(10)).users.map(
          (user) => user.userId,
        ),
        ghostScore: await raw.send('ZSCORE', [onlineKey, ghostUserId]),
      },
      expected: { online: [liveUserId], ghostScore },
    });
  }));

test('sweepOnlinePresence removes expired members and keeps live ones', () =>
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const liveUserId = createId();
    const ghostUserId = createId();
    const onlineKey = key('presence', 'online');
    await redis.upsertPresenceLease(lease('liveConn', liveUserId), 100);
    await raw.send('ZADD', [
      onlineKey,
      String((await serverNowMs()) - 5_000),
      ghostUserId,
    ]);
    const removed = await redis.sweepOnlinePresence(10);
    assert({
      given: 'a ghost scored in the past beside a live user',
      should: 'remove exactly the ghost',
      actual: {
        removed,
        ghost: await raw.send('ZSCORE', [onlineKey, ghostUserId]),
        live: (await raw.send('ZSCORE', [onlineKey, liveUserId])) !== null,
      },
      expected: { removed: 1, ghost: null, live: true },
    });
  }));

test('a sweep at the limit cap removes exactly the cap from a larger backlog, and the next sweep drains the rest', () =>
  // ISSUE-46: the sweep passes every expired member to one ZREM through
  // Lua's unpack, which fails past about 8,000 values ("too many results to
  // unpack", nothing removed). The cap keeps every accepted limit far below
  // that; this proves the cap itself against real Redis.
  withRedis(url, async ({ redis, raw, key, serverNowMs }) => {
    const onlineKey = key('presence', 'online');
    const past = String((await serverNowMs()) - 5_000);
    await raw.send('ZADD', [
      onlineKey,
      ...Array.from({ length: PRESENCE_LIMIT_MAX + 10 }, () => [
        past,
        createId(),
      ]).flat(),
    ]);
    const first = await redis.sweepOnlinePresence(PRESENCE_LIMIT_MAX);
    const second = await redis.sweepOnlinePresence(PRESENCE_LIMIT_MAX);
    assert({
      given: `${PRESENCE_LIMIT_MAX + 10} expired members and two capped sweeps`,
      should: 'remove the cap, then the remaining ten, leaving none',
      actual: { first, second, left: await raw.send('ZCARD', [onlineKey]) },
      expected: { first: PRESENCE_LIMIT_MAX, second: 10, left: 0 },
    });
  }));

test('readUserConnections returns at most its bound, latest expiry first', () =>
  // ISSUE-46: the per-user read is bounded like the online read, so an
  // user with many live connections never makes one read unbounded.
  withRedis(url, async ({ redis }) => {
    const userId = createId();
    const connIds = Array.from(
      { length: USER_CONNECTIONS_MAX + 3 },
      (_, index) => `bounded${index}`,
    );
    for (const [index, connId] of connIds.entries())
      await redis.upsertPresenceLease(lease(connId, userId), 100 + index);
    assert({
      given: `${USER_CONNECTIONS_MAX + 3} live connections for one user`,
      should: 'return the bound, latest expiry first',
      actual: (await redis.readUserConnections(userId)).connections.map(
        (connection) => connection.connId,
      ),
      expected: connIds.slice(3).reverse(),
    });
  }));
