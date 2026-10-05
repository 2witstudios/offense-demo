import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { sql, type Column, type Table } from 'drizzle-orm';

/**
 * The most rows one retention call may delete. Each call is one short
 * statement; the retention sweep (`apps/web/src/server/retention-sweep.ts`)
 * repeats it, so a backlog drains over batches, never in one long delete.
 */
const RETENTION_BATCH_LIMIT = 500;

export type RetentionBatch = {
  /** UTC ISO cutoff: rows whose `at` column is strictly earlier go. */
  readonly before: string;
  readonly limit: number;
};

/**
 * The one bounded delete behind every retention operation (ISSUE-8 AC5):
 * at most `limit` rows of `table` whose `at` is before the cutoff, oldest
 * first, chosen with `FOR UPDATE SKIP LOCKED` so concurrent sweeps (every
 * server instance runs one) split a backlog without waiting on or
 * double-deleting each other, and so a row a writer holds is never waited
 * on. Returns the number deleted.
 *
 * Each call is one autocommitted statement over `execute`, never wrapped in
 * `database.transaction(...)`: a long-running transaction anywhere in the
 * cluster holds back `pg_snapshot_xmin`, which `drainOutbox` depends on to
 * decide an outbox row is final (ADR 0032), so retention must never hold one
 * open across many rows or many batches. A missing, fractional,
 * non-positive or over-the-cap limit, or an unparsable cutoff, is refused
 * before any statement runs.
 */
export async function deleteExpiredBatch(
  db: Pick<BunSQLDatabase, 'execute'>,
  target: { readonly table: Table; readonly key: Column; readonly at: Column },
  { before, limit }: RetentionBatch,
): Promise<number> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > RETENTION_BATCH_LIMIT ||
    Number.isNaN(Date.parse(before))
  )
    throw new Error('Invalid retention bounds');
  const { table, key, at } = target;
  const deleted = await db.execute(sql`
    delete from ${table} where ${key} in (
      select ${key} from ${table}
      where ${at} < ${before}::timestamptz
      order by ${at}
      limit ${limit}
      for update skip locked
    ) returning ${key}
  `);
  return (deleted as unknown as unknown[]).length;
}
