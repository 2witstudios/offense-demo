import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestDatabase, type SinkEvent } from './index.test-support';

setupRitewayBun();

const before = '2026-09-19T00:00:00.000Z';

/**
 * ISSUE-8 AC5: every retention operation is one call of the same bounded
 * delete (`deleteExpiredBatch`), so its shape and bounds are tested once
 * here, and each operation only proves which table and column it prunes.
 */
describe('retention batch', () => {
  test('each retention operation deletes one bounded, lock-skipping batch of its own table by its own time column', async () => {
    const operations = [
      ['purgeExpiredVerifications', 'verification', 'expires_at'],
      ['purgeExpiredOutboxEvents', 'outbox', 'created_at'],
      [
        'purgeExpiredEmailDeliveryEvents',
        'email_delivery_event',
        'received_at',
      ],
      ['purgeExpiredEmailDeliveries', 'email_delivery', 'updated_at'],
      ['purgeExpiredSessions', 'session', 'expires_at'],
    ] as const;
    const shapes = await Promise.all(
      operations.map(async ([operation, table, column]) => {
        const { database, queries } = createTestDatabase([[['a'], ['b']]]);
        const deleted = await database[operation]({ before, limit: 500 });
        const text = queries[0]?.query ?? '';
        return {
          operation,
          deleted,
          statements: queries.length,
          deletesTable: text.trimStart().startsWith(`delete from "${table}"`),
          byTimeColumn: text.includes(
            `"${table}"."${column}" < $1::timestamptz`,
          ),
          oldestFirst: text.includes(`order by "${table}"."${column}"`),
          limited: /limit \$2/.test(text),
          skipLocked: text.includes('for update skip locked'),
          params: queries[0]?.params,
        };
      }),
    );
    assert({
      given: 'a cutoff and a batch limit for each retention operation',
      should:
        'issue exactly one delete of that table over a limited, oldest-first, lock-skipping subselect on its time column, and report the count',
      actual: shapes,
      expected: operations.map(([operation]) => ({
        operation,
        deleted: 2,
        statements: 1,
        deletesTable: true,
        byTimeColumn: true,
        oldestFirst: true,
        limited: true,
        skipLocked: true,
        params: [before, 500],
      })),
    });
  });

  test('refuses an invalid limit or cutoff instead of deleting unbounded', async () => {
    const { database, queries } = createTestDatabase([[]]);
    const results = await Promise.all(
      [
        { before, limit: 0 },
        { before, limit: -1 },
        { before, limit: 1.5 },
        { before, limit: 501 },
        { before: 'not a date', limit: 5 },
      ].map((input) =>
        database
          .purgeExpiredEmailDeliveries(input)
          .then(() => 'ran')
          .catch(() => 'refused'),
      ),
    );
    assert({
      given:
        'a zero, negative, fractional and over-the-cap limit, and an unparsable cutoff',
      should: 'refuse each without touching the database',
      actual: { results, queries: queries.length },
      expected: { results: Array(5).fill('refused'), queries: 0 },
    });
  });

  test('an empty batch deletes nothing and a driver failure is reported and rethrown', async () => {
    const empty = createTestDatabase([[]]);
    const events: SinkEvent[] = [];
    const failing = createTestDatabase([new Error('boom')], events);
    const outcome = await failing.database
      .purgeExpiredOutboxEvents({ before, limit: 5 })
      .then(() => 'resolved')
      .catch(() => 'rejected');
    assert({
      given: 'nothing past the cutoff, and then a failing driver',
      should: 'return 0, and reject after reporting db.query.failed',
      actual: {
        none: await empty.database.purgeExpiredVerifications({
          before,
          limit: 5,
        }),
        outcome,
        reported: events.map((event) => event.event),
      },
      expected: { none: 0, outcome: 'rejected', reported: ['db.query.failed'] },
    });
  });
});
