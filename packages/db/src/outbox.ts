import type { BunSQLDatabase } from 'drizzle-orm/bun-sql/postgres';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  cursorSchema,
  isPayloadStorableOnTopic,
  outboxPayloadSchema,
} from '@offense-demo/protocol';
import { outbox } from './schema/outbox';
import { instrumented, type DatabaseEventSink } from './instrumented';
import { deleteExpiredBatch, type RetentionBatch } from './retention';

/**
 * Full validation of the append input (RT-2.2 hazard note, plan revision
 * 4.8 item 6, wired in per plan revision 4.11): `payload` must parse
 * against `@offense-demo/protocol`'s `outboxPayloadSchema` (also satisfying the
 * table's `outbox_payload_is_object` CHECK, since every variant is a strict
 * object), and `appendOutboxEvent` below also checks the payload's `kind`
 * against RT-2.1c's storage-side family rule (`isPayloadStorableOnTopic`)
 * before the insert — a mismatched pair is a clean application-level
 * validation error here, not a raw Postgres CHECK violation surfacing deep
 * inside the caller's transaction.
 */
const outboxAppendInputSchema = z.strictObject({
  topic: z.string().min(1).max(200),
  kind: z.string().min(1).max(100),
  version: z.number().int().positive(),
  payload: outboxPayloadSchema,
});
export type OutboxAppendInput = z.infer<typeof outboxAppendInputSchema>;

export type OutboxPosition = { readonly txid: string; readonly seq: bigint };

export type OutboxRow = OutboxPosition & {
  readonly topic: string;
  readonly kind: string;
  readonly version: number;
  readonly payload: unknown;
  readonly createdAt: string;
};

/** A transaction handle: what `database.transaction(async (tx) => ...)` hands the caller. */
type Tx = Pick<BunSQLDatabase, 'execute' | 'insert'>;

const XID8_MAX = 2n ** 64n - 1n;
const BIGSERIAL_MAX = 2n ** 63n - 1n;

/**
 * The cursor is an ordering token, not a secret (plan: "Cursor
 * correctness"), but its shape is still validated on every use so a
 * client-supplied string is never trusted as SQL. It is the protocol's
 * plain `txid:seq` string, not a further-encoded wrapper: a DB cursor must
 * parse as a protocol cursor (plan revision 4.8).
 */
export function encodeOutboxCursor(position: OutboxPosition): string {
  return `${position.txid}:${position.seq.toString()}`;
}

const invalidCursor = (cause?: unknown) =>
  new Error(
    'Invalid outbox cursor',
    cause === undefined ? undefined : { cause },
  );

/** Both parts against their real 64-bit column types (xid8 unsigned, bigserial signed). */
function assertInPositionRange(txid: bigint, seq: bigint): void {
  if (txid < 0n || txid > XID8_MAX || seq < 0n || seq > BIGSERIAL_MAX)
    throw invalidCursor();
}

/**
 * Shape-validated against `@offense-demo/protocol`'s `cursorSchema` — the same
 * `txid:seq` grammar every other cursor consumer uses — then range-checked
 * against the real 64-bit column types, so an out-of-range cursor is a
 * validation error here, not a Postgres cast error at the query.
 */
export function decodeOutboxCursor(cursor: unknown): OutboxPosition {
  const parsed = cursorSchema.safeParse(cursor);
  if (!parsed.success) throw invalidCursor();
  const [txidPart, seqPart] = parsed.data.split(':');
  if (!txidPart || !seqPart) throw invalidCursor();
  const txid = BigInt(txidPart);
  const seq = BigInt(seqPart);
  assertInPositionRange(txid, seq);
  return { txid: txidPart, seq };
}

/** The start of the log: every row is strictly after this position. */
export const OUTBOX_ORIGIN: OutboxPosition = { txid: '0', seq: 0n };

/**
 * Appends one outbox row inside the caller's transaction and issues
 * `pg_notify('outbox', position)` in the same transaction, so the
 * notification is only delivered to listeners once the transaction commits
 * (Postgres queues NOTIFY until commit) and never fires for a rollback.
 */
export async function appendOutboxEvent(
  tx: Tx,
  input: OutboxAppendInput,
): Promise<OutboxPosition> {
  const parsed = outboxAppendInputSchema.parse(input);
  if (parsed.kind !== parsed.payload.kind)
    throw new Error(
      `Outbox kind column "${parsed.kind}" does not match payload kind "${parsed.payload.kind}"`,
    );
  if (!isPayloadStorableOnTopic(parsed.topic, parsed.payload))
    throw new Error(
      `Outbox payload kind "${parsed.payload.kind}" is not storable on topic "${parsed.topic}"`,
    );
  const [row] = await tx
    .insert(outbox)
    .values(parsed)
    .returning({ seq: outbox.seq, txid: outbox.txid });
  if (!row) throw new Error('Outbox insert returned no row');
  const position: OutboxPosition = {
    txid: String(row.txid),
    seq: BigInt(row.seq),
  };
  await tx.execute(
    sql`select pg_notify('outbox', ${encodeOutboxCursor(position)})`,
  );
  return position;
}

const MAX_DRAIN_LIMIT = 500;

/**
 * Commit-ordered drain (plan: "Cursor correctness"). Reads only rows whose
 * inserting transaction has finished for every observer
 * (`txid < pg_snapshot_xmin(pg_current_snapshot())`), so a row from a
 * transaction that committed after a higher `seq` became visible is never
 * skipped: it is still ordered by `(txid, seq)` ahead of positions already
 * drained past it.
 */
export async function drainOutbox(
  db: Pick<BunSQLDatabase, 'execute'>,
  cursor: OutboxPosition,
  limit = MAX_DRAIN_LIMIT,
): Promise<readonly OutboxRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DRAIN_LIMIT)
    throw new Error('Invalid outbox drain limit');
  const result = await db.execute(sql`
    select seq, txid, topic, kind, version, payload, created_at as "createdAt"
    from outbox
    where (txid, seq) > (${cursor.txid}::xid8, ${cursor.seq.toString()}::bigint)
      and txid < pg_snapshot_xmin(pg_current_snapshot())
    order by txid, seq
    limit ${limit}
  `);
  return (result as unknown as Record<string, unknown>[]).map((row) => ({
    seq: BigInt(row.seq as string | number | bigint),
    txid: String(row.txid),
    topic: String(row.topic),
    kind: String(row.kind),
    version: Number(row.version),
    payload: row.payload,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt),
  }));
}

/**
 * The greatest final position: the highest `(txid, seq)` whose transaction
 * has finished for every observer (ADR 0032 §2). Instance startup reads
 * this exactly once, after `LISTEN` acknowledges, to seed the drain loop's
 * cursor; instances hold no history of their own, and clients bring their
 * own cursors. An empty outbox has no final position, so the origin stands
 * in for "nothing yet".
 */
export async function readOutboxHighWaterMark(
  db: Pick<BunSQLDatabase, 'execute'>,
): Promise<OutboxPosition> {
  const result = await db.execute(sql`
    select txid, seq
    from outbox
    where txid < pg_snapshot_xmin(pg_current_snapshot())
    order by txid desc, seq desc
    limit 1
  `);
  const [row] = result as unknown as Record<string, unknown>[];
  if (!row) return OUTBOX_ORIGIN;
  return {
    txid: String(row.txid),
    seq: BigInt(row.seq as string | number | bigint),
  };
}

/**
 * The outbox area's production surface (ISSUE-8 AC1): its retention batch,
 * the RT-2.3b drain loop's two reads, wrapped with the one failure wrapper.
 * `appendOutboxEvent` runs inside a caller's own transaction and is composed
 * directly by the areas that need it (auth's `session.revoked`, rooms'
 * future write paths), not through this factory.
 */
export const outboxOperations = ({
  database,
  eventSink,
}: {
  readonly database: Pick<BunSQLDatabase, 'execute'>;
  readonly eventSink?: DatabaseEventSink | undefined;
}) => ({
  /**
   * Retention (plan: "Maintenance prunes the outbox after a retention
   * window"): one bounded batch of rows created before the cutoff, in its
   * own short autocommitted statement so it never holds back the
   * `pg_snapshot_xmin` that `drainOutbox` waits on (see `deleteExpiredBatch`).
   */
  async purgeExpiredOutboxEvents(input: RetentionBatch): Promise<number> {
    return instrumented(eventSink, 'purgeExpiredOutboxEvents', () =>
      deleteExpiredBatch(
        database,
        { table: outbox, key: outbox.seq, at: outbox.createdAt },
        input,
      ),
    );
  },
  /**
   * The RT-2.3b drain loop's one range query per wakeup, bound to this
   * instance's own connection pool so `apps/realtime` never touches the
   * Drizzle handle directly (ISSUE-8 AC1's boundary).
   */
  async drainOutbox(
    cursor: OutboxPosition,
    limit?: number,
  ): Promise<readonly OutboxRow[]> {
    return instrumented(eventSink, 'drainOutbox', () =>
      drainOutbox(database, cursor, limit),
    );
  },
  /** The RT-2.3b startup read (ADR 0032 §2), bound the same way. */
  async readOutboxHighWaterMark(): Promise<OutboxPosition> {
    return instrumented(eventSink, 'readOutboxHighWaterMark', () =>
      readOutboxHighWaterMark(database),
    );
  },
});
