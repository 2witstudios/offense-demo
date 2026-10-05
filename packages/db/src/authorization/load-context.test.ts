import { rejectionOf } from '@offense-demo/errors/testing';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestDatabase, type SinkEvent } from '../index.test-support';

setupRitewayBun();

const projects = { kind: 'projects' } as const;

describe('loadAuthorizationContext', () => {
  test('an anonymous principal needs no query', async () => {
    const { database, queries } = createTestDatabase([]);
    assert({
      given: 'no user id and the projects collection',
      should: 'answer the collection with no deny fact, reading nothing',
      actual: {
        projection: await database.loadAuthorizationContext({
          userId: null,
          resourceRef: projects,
        }),
        queries: queries.length,
      },
      expected: {
        projection: { resource: projects, accountErased: false },
        queries: 0,
      },
    });
  });

  test('a live account reads only its tombstone column', async () => {
    const { database, queries } = createTestDatabase([[[null]]]);
    const projection = await database.loadAuthorizationContext({
      userId: 'user1',
      resourceRef: projects,
    });
    const statement = queries[0]?.query ?? '';
    assert({
      given: 'a user row with no deleted_at',
      should:
        'select deleted_at alone from users by id and report no account-erased fact',
      actual: {
        projection,
        selects: statement.startsWith('select "deleted_at" from "users"'),
        params: queries[0]?.params,
      },
      expected: {
        projection: { resource: projects, accountErased: false },
        selects: true,
        params: ['user1', 1],
      },
    });
  });

  test('a tombstoned or missing account is erased', async () => {
    const tombstoned = createTestDatabase([
      [[new Date('2026-01-01T00:00:00.000Z')]],
    ]);
    const missing = createTestDatabase([[]]);
    const load = (database: typeof missing.database) =>
      database.loadAuthorizationContext({
        userId: 'user1',
        resourceRef: projects,
      });
    assert({
      given: 'a user row with deleted_at set, and no user row at all',
      should: 'report account-erased for both, failing closed',
      actual: [await load(tombstoned.database), await load(missing.database)],
      expected: [
        { resource: projects, accountErased: true },
        { resource: projects, accountErased: true },
      ],
    });
  });

  test('a failed read is reported and rethrown', async () => {
    const events: SinkEvent[] = [];
    const { database } = createTestDatabase([new Error('down')], events);
    const rejection = await rejectionOf(() =>
      database.loadAuthorizationContext({
        userId: 'user1',
        resourceRef: projects,
      }),
    );
    assert({
      given: 'a database that refuses the read',
      should: 'reject and report db.query.failed for the operation',
      actual: { rejection, events: events.map(({ fields }) => fields) },
      expected: {
        rejection: { code: 'NOT_APP_ERROR', name: 'DrizzleQueryError' },
        events: [{ operation: 'loadAuthorizationContext' }],
      },
    });
  });
});
