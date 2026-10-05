import { sql } from 'drizzle-orm';
import {
  bigserial,
  customType,
  index,
  integer,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { outboxPayloadSchema } from '@offense-demo/protocol';
import { jsonbColumn, jsonbIsObject, timestampColumn } from './columns';

/**
 * Postgres 13+ 64-bit transaction id. Comparable (`<`, `>`) but not
 * arithmetic; carried as a decimal string because it can exceed
 * `Number.MAX_SAFE_INTEGER` over the database's lifetime.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

/**
 * Delivery log for the realtime service (ADR: outbox + LISTEN/NOTIFY). A
 * row is appended in the same transaction as the write it announces, so
 * `pg_notify` only fires on commit. `seq` is assigned at insert and commits
 * out of order; `txid` is what makes the drain query commit-ordered (see
 * `drainOutbox` in `../outbox.ts`). This is a delivery log, not event
 * sourcing: state stays in the tables the payload references.
 */
export const outbox = pgTable(
  'outbox',
  {
    seq: bigserial('seq', { mode: 'bigint' }).primaryKey(),
    txid: xid8('txid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    topic: text('topic').notNull(),
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    payload: jsonbColumn('payload', outboxPayloadSchema).notNull(),
    // statement_timestamp(), not now()/defaultNow(): the delivery-lag check
    // (plan "aggregate service availability") and the 24h prune both need
    // the moment this row was actually written, not this transaction's
    // start time, which now() would give for every row in a longer write.
    createdAt: timestampColumn('created_at')
      .notNull()
      .default(sql`statement_timestamp()`),
  },
  (table) => [
    index('outbox_txid_seq_idx').on(table.txid, table.seq),
    index('outbox_topic_idx').on(table.topic),
    index('outbox_created_at_idx').on(table.createdAt),
    // Every receiver `safeParse`s an object schema (plan "Payload policy");
    // a JSON scalar or array would silently fail every one of them.
    jsonbIsObject('outbox', table.payload),
  ],
);
