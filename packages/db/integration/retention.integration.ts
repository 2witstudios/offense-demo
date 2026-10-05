import { assert, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { createDatabase } from '../src';
import { requireTestServices } from '@offense-demo/config';
import { count, sqlRunner, tables } from './retention-tables';

const { databaseUrl: url } = requireTestServices(process.env);

setupRitewayBun();

const withSql = sqlRunner(url as string);

const HOUR = 3_600_000;
const now = Date.parse('2026-09-20T12:00:00.000Z');
const cutoff = new Date(now - 24 * HOUR).toISOString();
const hoursAgo = (hours: number) => new Date(now - hours * HOUR).toISOString();

test('each retained table loses only rows older than the cutoff, and a repeat run is a no-op', async () => {
  const tag = `rt-${createId().slice(0, 10)}`;
  const database = createDatabase({ url });
  try {
    const results = [];
    for (const table of tables) {
      // 30h and 25h old: past the 24h cutoff. 23h old and 1h in the future: kept.
      await withSql(async (sql) => {
        for (const hours of [30, 25, 23, -1])
          await table.insert(sql, tag, hoursAgo(hours));
      });
      const deleted = await database[table.operation]({
        before: cutoff,
        limit: 100,
      });
      const again = await database[table.operation]({
        before: cutoff,
        limit: 100,
      });
      results.push({
        operation: table.operation,
        // Other suites' rows may also be past the cutoff; only ours are counted.
        deletedAtLeastTwo: deleted >= 2,
        repeat: again,
        left: await withSql((sql) => table.left(sql, tag)),
      });
    }
    assert({
      given:
        'rows 30h and 25h past the cutoff time, 23h old and 1h in the future, in each retained table',
      should:
        'delete the two older than the cutoff, keep the other two, and make a repeat run delete nothing',
      actual: results,
      expected: tables.map(({ operation }) => ({
        operation,
        deletedAtLeastTwo: true,
        repeat: 0,
        left: 2,
      })),
    });
  } finally {
    await database.close();
    await withSql(async (sql) => {
      for (const table of tables) await table.clear(sql, tag);
      await sql`delete from users where id = ${tag}`;
    });
  }
});

test("a batch deletes exactly its limit of its own rows, never another suite's, and an email suppression is never pruned", async () => {
  const tag = `rt-${createId().slice(0, 10)}`;
  // Rows another suite could leave: older than this test's own, so a cutoff
  // that reached them would take them first (the batch deletes oldest first).
  const other = `rt-${createId().slice(0, 10)}`;
  // Year 1, not 2001: other suites date rows in 2001, and a cutoff there
  // makes this batch compete for them (ISSUE-255). Nothing else is this old,
  // so the cutoff reaches only this test's rows.
  const at = '0001-01-01T00:00:00.000Z';
  const [deliveries] = tables.filter(
    (table) => table.operation === 'purgeExpiredEmailDeliveries',
  );
  const database = createDatabase({ url });
  try {
    await withSql(async (sql) => {
      for (let index = 0; index < 5; index += 1)
        await deliveries!.insert(sql, tag, at);
      for (let index = 0; index < 3; index += 1)
        await deliveries!.insert(sql, other, '2000-12-31T00:00:00.000Z');
      await sql`insert into email_suppression (recipient_hash, reason, provider_message_id, created_at)
        values (${tag}, 'bounce', ${tag}, ${at})`;
    });
    const deleted = await database.purgeExpiredEmailDeliveries({
      before: '0001-01-02T00:00:00.000Z',
      limit: 2,
    });
    const [left, othersLeft, suppressions] = await withSql(async (sql) => [
      await deliveries!.left(sql, tag),
      await deliveries!.left(sql, other),
      await count(
        sql`select count(*)::int as n from email_suppression where recipient_hash = ${tag}`,
      ),
    ]);
    assert({
      given:
        "five of this test's delivery rows and a suppression, three older rows another suite left, and a batch limit of two",
      should:
        "delete exactly two of this test's rows, leave the other suite's rows and the suppression",
      actual: { deleted, left, othersLeft, suppressions },
      expected: { deleted: 2, left: 3, othersLeft: 3, suppressions: 1 },
    });
  } finally {
    await database.close();
    await withSql(async (sql) => {
      await deliveries!.clear(sql, tag);
      await deliveries!.clear(sql, other);
      await sql`delete from email_suppression where recipient_hash = ${tag}`;
    });
  }
});
