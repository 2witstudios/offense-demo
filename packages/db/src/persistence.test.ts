import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createTestDatabase,
  sampleUser,
  userRow,
  type SinkEvent,
} from './index.test-support';

setupRitewayBun();

const withSink = () => {
  const events: SinkEvent[] = [];
  return { events };
};

describe('database user persistence', () => {
  test('returns the stored user record after insert', async () => {
    const record = sampleUser();
    const { database } = createTestDatabase([[userRow(record)]]);

    assert({
      given: 'a user insert accepted by the database',
      should: 'return the stored record including defaults',
      actual: await database.createUser({
        id: record.id,
        username: record.username,
      }),
      expected: record,
    });
  });

  test('rejects and reports a user insert that returns no row', async () => {
    const { events } = withSink();
    const { database } = createTestDatabase([[]], events);

    await expect(
      database.createUser({
        id: 'a7b3c9d1e5f2k4m6n8p1r3t5',
        username: 'demo',
      }),
    ).rejects.toThrow('User insert returned no row');

    assert({
      given: 'a user insert that silently returns nothing',
      should: 'report the failed user creation operation',
      actual: events,
      expected: [
        {
          event: 'db.query.failed',
          fields: { operation: 'createUser' },
          message: 'Database query failed',
        },
      ],
    });
  });
});

describe('claimUsername', () => {
  const claim = { userId: 'a7b3c9d1e5f2k4m6n8p1r3t5', username: 'ada' };

  test('claims a name for a user that has none', async () => {
    const { database, queries } = createTestDatabase([
      [['a7b3c9d1e5f2k4m6n8p1r3t5']],
    ]);
    assert({
      given: 'an update that matched the username-less user',
      should: 'report claimed, guarded by username IS NULL',
      actual: [
        (await database.claimUsername(claim)).kind,
        queries[0]?.query.includes('"username" is null'),
      ],
      expected: ['claimed', true],
    });
  });

  test('reports an owner retry as unchanged and a different name as already set', async () => {
    const same = createTestDatabase([[], [['ADA']]]);
    const other = createTestDatabase([[], [['grace']]]);
    assert({
      given: 'no row updated and a stored name equal, or not, to the request',
      should: 'answer unchanged for the same name and already-set otherwise',
      actual: [
        (await same.database.claimUsername(claim)).kind,
        (await other.database.claimUsername(claim)).kind,
      ],
      expected: ['unchanged', 'already-set'],
    });
  });

  test('reports an unknown user and a unique violation', async () => {
    const missing = createTestDatabase([[], []]);
    const conflict = createTestDatabase([
      Object.assign(new Error('duplicate'), { code: '23505' }),
    ]);
    // The shape Bun SQL really produces: drizzle wraps a PostgresError whose
    // SQLSTATE is `errno` and whose `code` is a driver constant.
    const wrapped = createTestDatabase([
      Object.assign(new Error('Failed query'), {
        cause: Object.assign(new Error('duplicate'), {
          code: 'ERR_POSTGRES_SERVER_ERROR',
          errno: '23505',
        }),
      }),
    ]);
    assert({
      given: 'a missing user and unique violations, bare and wrapped',
      should: 'answer unknown-user and taken',
      actual: [
        (await missing.database.claimUsername(claim)).kind,
        (await conflict.database.claimUsername(claim)).kind,
        (await wrapped.database.claimUsername(claim)).kind,
      ],
      expected: ['unknown-user', 'taken', 'taken'],
    });
  });

  test('rethrows and reports any other failure', async () => {
    const events: SinkEvent[] = [];
    const { database } = createTestDatabase([new Error('boom')], events);
    await expect(database.claimUsername(claim)).rejects.toThrow('Failed query');
    assert({
      given: 'a non-uniqueness database failure',
      should: 'report the failed operation',
      actual: events.map((event) => event.fields),
      expected: [{ operation: 'claimUsername' }],
    });
  });
});
