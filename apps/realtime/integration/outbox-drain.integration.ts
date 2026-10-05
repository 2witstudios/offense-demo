import { SQL } from 'bun';
import { assert, test, setupRitewayBun } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { systemId } from '@offense-demo/clock';
import type { OutboxRow } from '@offense-demo/db';
import { buildRoomTopic } from '@offense-demo/protocol';
import {
  bootServer,
  databaseUrl,
  insertAndNotifyBurst,
  insertOutboxRow,
  notifyOutbox,
  waitFor,
} from './support';

setupRitewayBun();

requireTestServices(process.env);

test('a burst of notifications for many committed, distinct-payload rows produces at most 2 range queries relevant to it, never one per event', async () => {
  const delivered: OutboxRow[] = [];
  const BURST_SIZE = 30;
  const topic = buildRoomTopic(systemId.next());
  // Two counters, for two different regressions (RT-2.3b-f1 criterion 2):
  // `relevantQueries` (from the sink) is precise but, on its own, cannot
  // tell one coalesced query that happens to grab every row from many
  // uncoalesced queries that each happen to grab every row too (removing
  // the loop's `running` guard does not stop the first query from still
  // draining everything, since all 30 rows commit in one transaction and
  // become visible together) — so `totalQueries` (every `drainOutbox`
  // call, via `onQuery`) also has to stay far below one-per-event (30).
  // It counts every wake, not only this burst's, so it is bounded rather
  // than asserted equal to `relevantQueries`.
  let relevantQueries = 0;
  let totalQueries = 0;
  // A long poll interval isolates the NOTIFY path: any query observed here
  // comes from coalesced wakeups, not the correctness-mechanism poll.
  const { close } = await bootServer({
    sink: (rows) => {
      delivered.push(...rows);
      if (rows.some((row) => row.topic === topic)) relevantQueries += 1;
    },
    pollIntervalMs: 60_000,
    onQuery: () => {
      totalQueries += 1;
    },
  });
  const client = new SQL(databaseUrl);
  try {
    const queriesBefore = totalQueries;
    // One transaction, distinct payloads: PostgreSQL folds identical NOTIFY
    // payloads sent in one transaction into a single delivery, so this is
    // what actually proves a burst rather than de-duplication.
    await insertAndNotifyBurst(client, topic, BURST_SIZE);

    await waitFor(
      () =>
        delivered.filter((row) => row.topic === topic).length === BURST_SIZE,
    );

    assert({
      given: `${BURST_SIZE} committed rows with distinct payloads, notified together in one transaction`,
      should:
        'deliver every row via at most 2 coalesced range queries that actually carried one of its rows, and stay far under one query per event overall',
      actual: {
        deliveredCount: delivered.filter((row) => row.topic === topic).length,
        queriesAtMostTwo: relevantQueries <= 2,
        totalQueriesFarBelowBurstSize: totalQueries - queriesBefore <= 5,
      },
      expected: {
        deliveredCount: BURST_SIZE,
        queriesAtMostTwo: true,
        totalQueriesFarBelowBurstSize: true,
      },
    });
  } finally {
    await client.unsafe('delete from outbox where topic = $1', [topic]);
    await client.close();
    await close();
  }
});

test('no notifications still delivers within the poll interval, since the poll is the correctness mechanism, not a fallback', async () => {
  const delivered: OutboxRow[] = [];
  const { close } = await bootServer({
    sink: (rows) => {
      delivered.push(...rows);
    },
    pollIntervalMs: 50,
  });
  const client = new SQL(databaseUrl);
  const topic = buildRoomTopic(systemId.next());
  try {
    // No pg_notify call: only the poll can ever see this row.
    await insertOutboxRow(client, {
      topic,
      kind: 'room.changed',
      version: 1,
      payload: { entityVersion: 1, kind: 'room.changed', ids: [topic] },
    });

    await waitFor(() => delivered.some((row) => row.topic === topic), 2000);

    assert({
      given: 'a committed row with no NOTIFY ever sent for it',
      should: 'still be delivered by the next 1 s-scale poll tick',
      actual: delivered.filter((row) => row.topic === topic).length,
      expected: 1,
    });
  } finally {
    await client.unsafe('delete from outbox where topic = $1', [topic]);
    await client.close();
    await close();
  }
});

test('a LISTEN reconnect drains from the in-memory cursor, missing nothing', async () => {
  const delivered: OutboxRow[] = [];
  const tag = `rt_reconnect_${systemId.next().slice(0, 10)}`;
  let listenWakeCount = 0;
  // The poll is disabled for the length of this test (60 s) so that any
  // delivery observed here can only come from the reconnect's own wakeup,
  // isolating that claim from the correctness-mechanism poll, which would
  // otherwise mask a missed reconnect.
  const { close } = await bootServer({
    sink: (rows) => {
      delivered.push(...rows);
    },
    pollIntervalMs: 60_000,
    applicationNameTag: tag,
    onListenWake: () => {
      listenWakeCount += 1;
    },
  });
  const client = new SQL(databaseUrl);
  const killer = new SQL(databaseUrl);
  const topicBefore = buildRoomTopic(systemId.next());
  const topicAfter = buildRoomTopic(systemId.next());
  try {
    const before = await insertOutboxRow(client, {
      topic: topicBefore,
      kind: 'room.changed',
      version: 1,
      payload: {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [topicBefore],
      },
    });
    await notifyOutbox(client, before);
    await waitFor(() => delivered.some((row) => row.topic === topicBefore));

    const listenWakesBeforeKill = listenWakeCount;

    // Committed with no NOTIFY ever sent for it, inserted only once
    // topicBefore's own delivery (and hence the drain's cursor) has
    // already settled: the only way this instance can ever learn about it
    // is a wake that queries from the cursor: the reconnect's catch-up.
    // Sending a NOTIFY for it and racing the
    // reconnect's timing, as an earlier version of this test did, is
    // fragile: if the NOTIFY happens to go out after Bun has already
    // finished reconnecting, it arrives over the ordinary, already-working
    // onNotify path and proves nothing about the catch-up wake specifically.
    await insertOutboxRow(client, {
      topic: topicAfter,
      kind: 'room.changed',
      version: 1,
      payload: {
        entityVersion: 1,
        kind: 'room.changed',
        ids: [topicAfter],
      },
    });

    const terminated = await killer.unsafe(
      'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()',
      [tag],
    );
    if (terminated.length === 0)
      throw new Error(
        `No backend tagged application_name=${tag} was found to terminate; the reconnect this test proves never happened`,
      );

    // Two independent proofs: the reconnect itself happened (via
    // `onListenWake`, immune to any other suite's traffic on the shared
    // channel — RT-2.3b-f1 criterion 2), and the row was actually
    // delivered.
    await waitFor(() => listenWakeCount > listenWakesBeforeKill, 15_000);
    await waitFor(
      () => delivered.some((row) => row.topic === topicAfter),
      15_000,
    );

    assert({
      given:
        'the LISTEN connection killed after one row is delivered, then a second row committed and notified',
      should:
        'reconnect (observed independently of any other traffic), catch up from the in-memory cursor via onlisten, and deliver the second row too',
      actual: {
        reconnectedOwnConnection: listenWakeCount > listenWakesBeforeKill,
        firstDelivered: delivered.some((row) => row.topic === topicBefore),
        secondDelivered: delivered.some((row) => row.topic === topicAfter),
      },
      expected: {
        reconnectedOwnConnection: true,
        firstDelivered: true,
        secondDelivered: true,
      },
    });
  } finally {
    await client.unsafe('delete from outbox where topic = $1', [topicBefore]);
    await client.unsafe('delete from outbox where topic = $1', [topicAfter]);
    await client.close();
    await killer.close();
    await close();
  }
}, 20_000);
