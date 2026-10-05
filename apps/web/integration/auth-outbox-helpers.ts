import { createId } from '@paralleldrive/cuid2';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import { SQL } from 'bun';
import { testDatabaseUrl, withSql } from './fixtures';

/**
 * RT-2.2: shared fixtures for suites that assert an auth operation appends a
 * `session.revoked` outbox row to the acting user's inbox topic
 * (`user:<userId>:inbox`).
 */
/** Outbox rows a `session.revoked`-emitting operation appended for this user. */
const sessionRevokedEvents = (userId: string) =>
  withSql(
    (sql) =>
      sql`SELECT topic FROM outbox WHERE kind = 'session.revoked' AND topic = ${buildUserInboxTopic(userId)}`,
  ).then((rows) => rows.length);

const cleanupOutboxFor = (userId: string) =>
  withSql(
    (sql) =>
      sql`DELETE FROM outbox WHERE kind = 'session.revoked' AND topic = ${buildUserInboxTopic(userId)}`,
  );

/**
 * Forces one genuine Postgres-level `appendOutboxEvent` failure (RT-2.2v
 * minor 3), scoped to exactly one topic: a `BEFORE INSERT` trigger that
 * raises only for that topic's rows, dropped again once `work` settles.
 * Renaming the shared `outbox` table away for the duration of `work` would
 * fail every unrelated insert and drain and hold an ACCESS EXCLUSIVE lock
 * for that whole window; a topic-scoped trigger rejects only inserts naming
 * this fixture's own topic. Its `CREATE`/`DROP TRIGGER` still queue behind
 * every open transaction that wrote `outbox`, and every later insert queues
 * behind them, which is why the root `test:integration` runs one
 * workspace at a time (ISSUE-61, ISSUE-100). Two real consumers:
 * `auth-session-revoked-outbox.integration.ts` and
 * `auth-email-change-atomicity.integration.ts`.
 */
export const withOutboxInsertBlockedForTopic = async (
  topic: string,
  work: () => Promise<void>,
) => {
  const admin = new SQL(testDatabaseUrl);
  const name = `outbox_force_failure_${createId()}`;
  const escapedTopic = topic.replace(/'/g, "''");
  try {
    await admin.unsafe(`
      create function "${name}"() returns trigger as $body$
      begin
        if new.topic = '${escapedTopic}' then
          raise exception 'forced outbox failure for topic % (fixture-scoped)', new.topic;
        end if;
        return new;
      end;
      $body$ language plpgsql
    `);
    await admin.unsafe(`
      create trigger "${name}_trigger" before insert on outbox
      for each row execute function "${name}"()
    `);
    await work();
  } finally {
    await admin.unsafe(`drop trigger if exists "${name}_trigger" on outbox`);
    await admin.unsafe(`drop function if exists "${name}"()`);
    await admin.close();
  }
};

/**
 * Counts the `session.revoked` rows appended to a user's inbox from now on;
 * `cleanup` removes those rows again.
 */
export const trackRevocations = async (userId: string) => {
  const before = await sessionRevokedEvents(userId);
  return {
    appended: async () => (await sessionRevokedEvents(userId)) - before,
    cleanup: () => cleanupOutboxFor(userId),
  };
};
