import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import type { Database } from '../src';

// The retained-table fixtures shared by retention.integration.ts and
// retention-concurrency.integration.ts.

/**
 * One fixture per retained table (ISSUE-8 AC5): `insert` writes a row
 * tagged with this run's marker and timed `at`; `left` counts the tagged
 * rows still stored. Rows are tagged so concurrent suites never collide.
 */
type Table = {
  readonly operation: keyof Pick<
    Database,
    | 'purgeExpiredVerifications'
    | 'purgeExpiredOutboxEvents'
    | 'purgeExpiredEmailDeliveryEvents'
    | 'purgeExpiredEmailDeliveries'
    | 'purgeExpiredSessions'
  >;
  readonly insert: (sql: SQL, tag: string, at: string) => Promise<unknown>;
  readonly left: (sql: SQL, tag: string) => Promise<number>;
  readonly clear: (sql: SQL, tag: string) => Promise<unknown>;
};
export const count = async (rows: Promise<Array<{ n: number }>>) =>
  (await rows)[0]?.n ?? 0;
export const tables: readonly Table[] = [
  {
    operation: 'purgeExpiredVerifications',
    insert: (sql, tag, at) => sql`
      insert into verification (id, identifier, value, expires_at)
      values (${`${tag}-${createId()}`}, ${`hash-${tag}`}, '{}', ${at})`,
    left: (sql, tag) =>
      count(
        sql`select count(*)::int as n from verification where id like ${`${tag}-%`}`,
      ),
    clear: (sql, tag) =>
      sql`delete from verification where id like ${`${tag}-%`}`,
  },
  {
    operation: 'purgeExpiredOutboxEvents',
    insert: (sql, tag, at) => sql`
      insert into outbox (topic, kind, version, payload, created_at)
      values (${tag}, 'test.retention', 1, '{}'::jsonb, ${at})`,
    left: (sql, tag) =>
      count(sql`select count(*)::int as n from outbox where topic = ${tag}`),
    clear: (sql, tag) => sql`delete from outbox where topic = ${tag}`,
  },
  {
    operation: 'purgeExpiredEmailDeliveryEvents',
    insert: (sql, tag, at) => sql`
      insert into email_delivery_event (provider_event_id, provider_message_id, received_at)
      values (${`${tag}-${createId()}`}, ${tag}, ${at})`,
    left: (sql, tag) =>
      count(
        sql`select count(*)::int as n from email_delivery_event where provider_message_id = ${tag}`,
      ),
    clear: (sql, tag) =>
      sql`delete from email_delivery_event where provider_message_id = ${tag}`,
  },
  {
    operation: 'purgeExpiredEmailDeliveries',
    insert: (sql, tag, at) => sql`
      insert into email_delivery (id, provider_message_id, recipient_hash, status, status_rank, created_at, updated_at)
      values (${createId()}, ${`${tag}-${createId()}`}, ${tag}, 'sent', 1, ${at}, ${at})`,
    left: (sql, tag) =>
      count(
        sql`select count(*)::int as n from email_delivery where recipient_hash = ${tag}`,
      ),
    clear: (sql, tag) =>
      sql`delete from email_delivery where recipient_hash = ${tag}`,
  },
  {
    operation: 'purgeExpiredSessions',
    insert: async (sql, tag, at) => {
      await sql`
        insert into users (id, name) values (${tag}, '')
        on conflict (id) do nothing`;
      await sql`
        insert into session (id, expires_at, token, user_id)
        values (${`${tag}-${createId()}`}, ${at}, ${`${tag}-${createId()}`}, ${tag})`;
    },
    left: (sql, tag) =>
      count(sql`select count(*)::int as n from session where user_id = ${tag}`),
    clear: (sql, tag) => sql`delete from session where user_id = ${tag}`,
  },
];

/**
 * `withSql(work)` for one suite's database: runs `work` on a fresh
 * one-connection client to `url`, then closes it.
 */
export const sqlRunner =
  (url: string) =>
  async <T>(work: (sql: SQL) => Promise<T>): Promise<T> => {
    const sql = new SQL(url, { max: 1 });
    try {
      return await work(sql);
    } finally {
      await sql.close();
    }
  };
