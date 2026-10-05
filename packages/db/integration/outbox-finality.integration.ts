import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { OUTBOX_ORIGIN, drainOutbox } from '../src/outbox';
import { waitForOutboxFinality } from '../src/testing';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/**
 * ISSUE-82: `pg_snapshot_xmin` is cluster-wide (ADR 0032 §1), so an
 * xid-holding transaction in another database of the same PostgreSQL (on
 * the shared local stack, another checkout's slot) holds back this
 * database's drain. The `postgres` maintenance database stands in for that
 * other database: it exists in every cluster, CI's included, and
 * `pg_current_xact_id()` gives the transaction an xid without writing
 * anything there.
 */
const openForeignTransaction = async () => {
  const foreignUrl = new URL(url);
  foreignUrl.pathname = '/postgres';
  const foreign = new SQL(foreignUrl.toString(), { max: 1 });
  await foreign.unsafe('BEGIN');
  await foreign.unsafe('select pg_current_xact_id()');
  return foreign;
};

const insertRow = async (client: SQL, topic: string) => {
  const [row] = await client.unsafe(
    "insert into outbox (topic, kind, version, payload) values ($1, 'test.finality', 1, '{}'::jsonb) returning txid",
    [topic],
  );
  return String((row as { txid: string | bigint }).txid);
};

test('an open transaction in another database holds back the drain, and the finality wait resolves once it ends', async () => {
  const client = new SQL(url, { max: 1 });
  const drizzleClient = drizzle({ client });
  const foreign = await openForeignTransaction();
  const topic = `room:${createId()}`;
  const drainedForTopic = async () =>
    (await drainOutbox(drizzleClient, OUTBOX_ORIGIN, 500)).filter(
      (row) => row.topic === topic,
    ).length;
  try {
    const txid = await insertRow(client, topic);
    const whileForeignOpen = await drainedForTopic();

    let settled = false;
    const waiting = waitForOutboxFinality(client, txid, { now: Date.now }).then(
      () => {
        settled = true;
      },
    );
    const settledWhileForeignOpen = await drainedForTopic().then(() => settled);

    await foreign.unsafe('COMMIT');
    await waiting;

    assert({
      given:
        'a committed outbox row while another database of the cluster has an open xid-holding transaction',
      should:
        'drain nothing for it and keep the finality wait pending until that transaction ends, then drain the row',
      actual: {
        whileForeignOpen,
        settledWhileForeignOpen,
        afterWait: await drainedForTopic(),
      },
      expected: {
        whileForeignOpen: 0,
        settledWhileForeignOpen: false,
        afterWait: 1,
      },
    });
  } finally {
    await foreign.unsafe('ROLLBACK').catch(() => undefined);
    await client.unsafe('delete from outbox where topic = $1', [topic]);
    await foreign.close();
    await client.close();
  }
});

test('a finality wait that outlives its deadline names the transactions holding it back', async () => {
  const client = new SQL(url, { max: 1 });
  const foreign = await openForeignTransaction();
  const topic = `room:${createId()}`;
  try {
    const txid = await insertRow(client, topic);
    const message = await waitForOutboxFinality(client, txid, {
      now: Date.now,
      deadlineMs: 200,
    }).then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    assert({
      given:
        'an outbox row held back by an open transaction in the postgres database past a 200 ms deadline',
      should: 'reject with a message naming the position and that database',
      actual: {
        namesPosition: message.includes(`txid ${txid} `),
        namesHolder: message.includes('database "postgres"'),
      },
      expected: { namesPosition: true, namesHolder: true },
    });
  } finally {
    await foreign.unsafe('ROLLBACK');
    await client.unsafe('delete from outbox where topic = $1', [topic]);
    await foreign.close();
    await client.close();
  }
});
