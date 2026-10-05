import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { assertRejects } from '@offense-demo/errors/testing';
import { createTestDatabase, type SinkEvent } from './index.test-support';

setupRitewayBun();

const owner = 'a7b3c9d1e5f2k4m6n8p1r3t5';
const record = {
  id: 'p1b3c9d1e5f2k4m6n8p1r3t5',
  ownerUserId: owner,
  name: 'Launch plan',
  status: 'active' as const,
  createdAt: '2026-01-02T03:04:05.678Z',
  updatedAt: '2026-01-02T03:04:05.678Z',
};

// Schema-definition column order; the driver returns rows positionally.
const projectRow = (stored: typeof record & { version: number }): unknown[] => [
  stored.id,
  stored.ownerUserId,
  stored.name,
  stored.status,
  stored.version,
  new Date(stored.createdAt),
  new Date(stored.updatedAt),
];

/** Bun SQL's foreign_key_violation, as the driver reports it. */
const foreignKeyViolation = () =>
  Object.assign(new Error('insert or update violates foreign key'), {
    errno: '23503',
    constraint: 'projects_owner_user_id_users_id_fkey',
  });

describe('insertProject', () => {
  test('writes the record with its own timestamps and returns the stored row as a record', async () => {
    const { database, queries } = createTestDatabase([
      [projectRow({ ...record, version: 1 })],
    ]);
    const stored = await database.insertProject(record);
    assert({
      given: 'a project record and a row the database stored for it',
      should:
        'return the stored record with UTC ISO timestamps and version 1, writing the record timestamps explicitly',
      actual: {
        stored,
        params: queries[0]?.params,
      },
      expected: {
        stored: { ...record, version: 1 },
        params: [
          record.id,
          record.ownerUserId,
          record.name,
          record.status,
          record.createdAt,
          record.updatedAt,
        ],
      },
    });
  });

  test('refuses an owner that is not a user as VALIDATION and reports the failure', async () => {
    const events: SinkEvent[] = [];
    const { database } = createTestDatabase([foreignKeyViolation()], events);
    await assertRejects({
      given: 'an insert the owner foreign key refuses',
      should: 'reject with VALIDATION',
      actual: () => database.insertProject(record),
      code: 'VALIDATION',
    });
    assert({
      given: 'the refused insert',
      should: 'report the operation to the event sink',
      actual: events.map(({ event, fields }) => ({ event, fields })),
      expected: [
        { event: 'db.query.failed', fields: { operation: 'insertProject' } },
      ],
    });
  });

  test('rethrows any other database failure unchanged', async () => {
    const failure = Object.assign(new Error('connection reset'), {
      errno: '08006',
    });
    const { database } = createTestDatabase([failure]);
    const caught = await database.insertProject(record).catch((e) => e);
    assert({
      given: 'a failure that is not a foreign-key violation',
      should: 'reach the caller as the same error',
      actual: caught === failure || caught?.cause === failure,
      expected: true,
    });
  });

  test('fails loudly when the insert returns no row', async () => {
    const { database } = createTestDatabase([[]]);
    const caught = await database.insertProject(record).catch((e) => e);
    assert({
      given: 'an insert whose RETURNING produced nothing',
      should: 'throw instead of returning a record that was never stored',
      actual: (caught as Error).message,
      expected: 'Project insert returned no row',
    });
  });
});

describe('listProjectsForOwner', () => {
  test('orders newest first with the id tiebreak, bounded by the limit, for one owner', async () => {
    const { database, queries } = createTestDatabase([
      [projectRow({ ...record, version: 1 })],
    ]);
    const listed = await database.listProjectsForOwner(owner, { limit: 20 });
    const query = queries[0]?.query ?? '';
    assert({
      given: 'an owner id and a limit',
      should:
        'filter by owner, order by created_at desc then id desc, and pass the limit',
      actual: {
        listed,
        filtersOwner: /where "projects"\."owner_user_id" = \$1/.test(query),
        orders:
          /order by "projects"\."created_at" desc, "projects"\."id" desc/.test(
            query,
          ),
        params: queries[0]?.params,
      },
      expected: {
        listed: [{ ...record, version: 1 }],
        filtersOwner: true,
        orders: true,
        params: [owner, 20],
      },
    });
  });

  test('caps the limit at 100 and defaults to it', async () => {
    const { database, queries } = createTestDatabase([[], []]);
    await database.listProjectsForOwner(owner);
    await database.listProjectsForOwner(owner, { limit: 500 });
    assert({
      given: 'no limit, then a limit above 100',
      should: 'ask the database for at most 100 rows',
      actual: queries.map(({ params }) => params.at(-1)),
      expected: [100, 100],
    });
  });

  test('refuses a limit that is not a positive integer without querying', async () => {
    const { database, queries } = createTestDatabase([]);
    for (const limit of [0, -1, 1.5, Number.NaN])
      await assertRejects({
        given: `the limit ${limit}`,
        should: 'reject with VALIDATION',
        actual: () => database.listProjectsForOwner(owner, { limit }),
        code: 'VALIDATION',
      });
    assert({
      given: 'only refused limits',
      should: 'send no query',
      actual: queries.length,
      expected: 0,
    });
  });
});
