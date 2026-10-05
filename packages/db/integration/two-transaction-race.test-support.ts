import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { waitForOutboxFinality } from '../src/testing';

export type RaceRow = {
  readonly txid: string | bigint;
  readonly seq: string | bigint;
};

/**
 * Opens transaction A, inserts, then opens and commits transaction B while
 * A is still open — the classic out-of-commit-order race both the drain's
 * and the high-water mark's "never skip a row" proofs exercise. B's own row
 * becomes ordinarily queryable by a third reader as soon as B commits (Read
 * Committed visibility); what stays held back until A also commits is the
 * high-water mark / drain cursor itself, since its whole contract is to
 * never advance past an earlier transaction that is still open, even though
 * a later one already committed. A third, uninvolved connection (`connC` /
 * `drizzleC`) is also opened, for the caller's own reads. `commitA` commits
 * A and returns once both rows are final (ISSUE-82): the cluster-wide
 * snapshot xmin can still be held back by another database's transaction.
 */
export async function openOutOfOrderTransactions(
  url: string,
  topic: string,
): Promise<{
  readonly connA: SQL;
  readonly connB: SQL;
  readonly connC: SQL;
  readonly drizzleC: BunSQLDatabase;
  readonly rowA: RaceRow;
  readonly rowB: RaceRow;
  readonly commitA: () => Promise<void>;
}> {
  const connA = new SQL(url, { max: 1 });
  const connB = new SQL(url, { max: 1 });
  const connC = new SQL(url, { max: 1 });
  try {
    await connA.unsafe('BEGIN');
    const [rowA] = await connA.unsafe(
      "insert into outbox (topic, kind, version, payload) values ($1, 'test.a', 1, '{}'::jsonb) returning seq, txid",
      [topic],
    );
    await connB.unsafe('BEGIN');
    const [rowB] = await connB.unsafe(
      "insert into outbox (topic, kind, version, payload) values ($1, 'test.b', 1, '{}'::jsonb) returning seq, txid",
      [topic],
    );
    await connB.unsafe('COMMIT');
    return {
      connA,
      connB,
      connC,
      drizzleC: drizzle({ client: connC }),
      rowA: rowA as RaceRow,
      rowB: rowB as RaceRow,
      async commitA() {
        await connA.unsafe('COMMIT');
        for (const row of [rowA, rowB] as RaceRow[])
          await waitForOutboxFinality(connC, String(row.txid), {
            now: Date.now,
          });
      },
    };
  } catch (error) {
    // A failure partway through must not leave connA holding an open
    // transaction (or any connection open): that would leak past this
    // function and could block or confuse whatever runs on this shared test
    // database next.
    await Promise.allSettled([
      connA.unsafe('ROLLBACK'),
      connB.unsafe('ROLLBACK'),
    ]);
    await Promise.allSettled([connA.close(), connB.close(), connC.close()]);
    throw error;
  }
}
