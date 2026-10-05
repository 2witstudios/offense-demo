import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestDatabase, unreachableDatabase } from './index.test-support';

setupRitewayBun();

// Split from index.test.ts to keep each file under the lint's line limit.

describe('session revocation', () => {
  test('locks the user row, then revokes every other session in one atomic statement and appends session.revoked to the user inbox in the same transaction', async () => {
    const userId = 'a7b3c9d1e5f2k4m6n8p1r3t5';
    const { database, queries } = createTestDatabase([
      [[userId]],
      [['session-row-id']],
      [['5', '10']],
      [],
    ]);

    const removed = await database.revokeOtherSessions(userId, 'keep-me');

    const lower = (index: number) => queries[index]?.query.toLowerCase() ?? '';
    const insertsOutbox =
      lower(2).includes('insert into') && lower(2).includes('outbox');

    assert({
      given: "a user's other sessions and the token to keep",
      should:
        'lock the user row first (ISSUE-22), then issue the DELETE with no listing query, then append the outbox row on user:<id>:inbox and NOTIFY in the same transaction',
      actual: {
        removed,
        queryCount: queries.length,
        locksUserRow:
          lower(0).includes('"users"') && lower(0).endsWith('for update'),
        lockParams: queries[0]?.params,
        deletesSession: lower(1).includes('delete'),
        mentionsUserId: queries[1]?.query.includes('user_id'),
        mentionsToken: queries[1]?.query.includes('token'),
        params: queries[1]?.params,
        insertsOutbox,
        inboxTopic: queries[2]?.params.includes(`user:${userId}:inbox`),
        notifies: lower(3).includes('pg_notify'),
      },
      expected: {
        removed: 1,
        queryCount: 4,
        locksUserRow: true,
        lockParams: [userId],
        deletesSession: true,
        mentionsUserId: true,
        mentionsToken: true,
        params: [userId, 'keep-me'],
        insertsOutbox: true,
        inboxTopic: true,
        notifies: true,
      },
    });
  });

  test('revokes every session, the current one included, when no token is kept', async () => {
    const userId = 'a7b3c9d1e5f2k4m6n8p1r3t5';
    const { database, queries } = createTestDatabase([
      [[userId]],
      [['session-a'], ['session-b']],
      [['5', '10']],
      [],
    ]);

    const removed = await database.revokeOtherSessions(userId, null);

    assert({
      given: 'a revoke-all with no session to keep',
      should: 'delete by the user alone, under the same lock',
      actual: {
        removed,
        locksUserRow: queries[0]?.query.toLowerCase().endsWith('for update'),
        mentionsToken: queries[1]?.query.includes('token'),
        params: queries[1]?.params,
      },
      expected: {
        removed: 2,
        locksUserRow: true,
        mentionsToken: false,
        params: [userId],
      },
    });
  });

  test('appends no outbox row when there is nothing to revoke', async () => {
    const userId = 'a7b3c9d1e5f2k4m6n8p1r3t5';
    const { database, queries } = createTestDatabase([[[userId]], []]);

    const removed = await database.revokeOtherSessions(userId, 'keep-me');

    assert({
      given: 'a user with no other sessions to revoke',
      should:
        'issue only the lock and the DELETE, appending nothing to the outbox',
      actual: { removed, queryCount: queries.length },
      expected: { removed: 0, queryCount: 2 },
    });
  });

  test('appendSessionRevoked (the single-session /revoke-session path) appends session.revoked to the user inbox, naming the user', async () => {
    const userId = 'a7b3c9d1e5f2k4m6n8p1r3t5';
    const { database, queries } = createTestDatabase([[['5', '10']], []]);

    await database.appendSessionRevoked(userId);

    const insert = queries[0];
    assert({
      given: 'a user whose single session Better Auth already deleted',
      should:
        'append one session.revoked row on user:<userId>:inbox with ids [userId], then NOTIFY',
      actual: {
        queryCount: queries.length,
        insertsOutbox: insert?.query.toLowerCase().includes('insert into'),
        topic: insert?.params.includes(`user:${userId}:inbox`),
        payload: JSON.stringify(insert?.params).includes(`"ids":["${userId}"]`),
        notifies: queries[1]?.query.toLowerCase().includes('pg_notify'),
      },
      expected: {
        queryCount: 2,
        insertsOutbox: true,
        topic: true,
        payload: true,
        notifies: true,
      },
    });
  });

  test('reports a failed revocation through the injected event sink', async () => {
    const { database, events } = unreachableDatabase();

    await expect(
      database.revokeOtherSessions('user-1', 'keep-me'),
    ).rejects.toMatchObject({ code: 'ERR_POSTGRES_CONNECTION_REFUSED' });

    assert({
      given: 'a session revocation that fails',
      should: 'emit the database query failure event with the operation name',
      actual: events,
      expected: [
        {
          event: 'db.query.failed',
          fields: { operation: 'revokeOtherSessions' },
          message: 'Database query failed',
        },
      ],
    });
  });
});
