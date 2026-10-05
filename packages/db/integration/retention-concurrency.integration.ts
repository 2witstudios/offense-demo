import { assert, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { count, sqlRunner, tables } from './retention-tables';
import { createDatabase, type Database } from '../src';
import { requireTestServices } from '@offense-demo/config';

const { databaseUrl: url } = requireTestServices(process.env);

setupRitewayBun();

const withSql = sqlRunner(url as string);

/**
 * Four independent connection pools draining one operation in batches of
 * five until each sees a short batch, all at once. Shared by the
 * verification and session concurrency proofs below.
 */
async function drainConcurrently(
  operation: 'purgeExpiredVerifications' | 'purgeExpiredSessions',
  isolatedBefore: string,
) {
  const workers = Array.from({ length: 4 }, () =>
    createDatabase({ url, maxConnections: 2 }),
  );
  const drain = async (database: Database) => {
    let total = 0;
    for (;;) {
      const deleted = await database[operation]({
        before: isolatedBefore,
        limit: 5,
      });
      total += deleted;
      if (deleted === 0) return total;
    }
  };
  const totals = await Promise.all(workers.map(drain));
  return { workers, totals };
}

test('concurrent sweeps delete each expired row exactly once', async () => {
  const tag = `rt-${createId().slice(0, 10)}`;
  const [verification] = tables;
  const isolatedBefore = '2001-01-01T01:00:00.000Z';
  await withSql(async (sql) => {
    for (let index = 0; index < 40; index += 1)
      await verification!.insert(sql, tag, '2001-01-01T00:00:00.000Z');
  });
  const { workers, totals } = await drainConcurrently(
    'purgeExpiredVerifications',
    isolatedBefore,
  );
  try {
    assert({
      given:
        'forty expired rows and four sweeps draining in batches of five at once',
      should: 'delete every row and count each deletion exactly once',
      actual: {
        left: await withSql((sql) => verification!.left(sql, tag)),
        deletions: totals.reduce((sum, total) => sum + total, 0),
      },
      expected: { left: 0, deletions: 40 },
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await withSql((sql) => verification!.clear(sql, tag));
  }
});

test('concurrent session sweeps race-free delete each expired session exactly once and never touch a live session, its user, or its passkey', async () => {
  const tag = `rt-${createId().slice(0, 10)}`;
  const [session] = tables.filter(
    (table) => table.operation === 'purgeExpiredSessions',
  );
  const isolatedBefore = '2001-01-01T01:00:00.000Z';
  await withSql(async (sql) => {
    await sql`insert into users (id, name) values (${tag}, '') on conflict (id) do nothing`;
    for (let index = 0; index < 40; index += 1)
      await session!.insert(sql, tag, '2001-01-01T00:00:00.000Z');
    // A live session (future expiry) and a passkey: neither is a retention target.
    await sql`insert into session (id, expires_at, token, user_id)
      values (${`${tag}-live`}, '2099-01-01T00:00:00.000Z', ${`${tag}-live-token`}, ${tag})`;
    await sql`insert into passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
      values (${`${tag}-passkey`}, 'pk', ${tag}, ${`${tag}-cred`}, 0, 'singleDevice', false)`;
  });
  const { workers, totals } = await drainConcurrently(
    'purgeExpiredSessions',
    isolatedBefore,
  );
  try {
    const [sessionsLeft, liveLeft, userLeft, passkeyLeft] = await withSql(
      async (sql) => [
        await session!.left(sql, tag),
        await count(
          sql`select count(*)::int as n from session where id = ${`${tag}-live`}`,
        ),
        await count(
          sql`select count(*)::int as n from users where id = ${tag}`,
        ),
        await count(
          sql`select count(*)::int as n from passkey where id = ${`${tag}-passkey`}`,
        ),
      ],
    );
    assert({
      given:
        'forty expired sessions, one live session, a passkey and their user, with four sweeps draining at once',
      should:
        'delete every expired session exactly once and leave the live session, the passkey and the user untouched',
      actual: {
        sessionsLeft,
        liveLeft,
        userLeft,
        passkeyLeft,
        deletions: totals.reduce((sum, total) => sum + total, 0),
      },
      expected: {
        sessionsLeft: 1,
        liveLeft: 1,
        userLeft: 1,
        passkeyLeft: 1,
        deletions: 40,
      },
    });
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await withSql(async (sql) => {
      await session!.clear(sql, tag);
      await sql`delete from passkey where id = ${`${tag}-passkey`}`;
      await sql`delete from users where id = ${tag}`;
    });
  }
});
