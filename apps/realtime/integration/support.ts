import { SQL } from 'bun';
import { requireTestServices } from '@offense-demo/config';
import { systemClock, systemId } from '@offense-demo/clock';
import { waitForOutboxFinality } from '@offense-demo/db/testing';
import { testNamespace } from '@offense-demo/redis/testing';
import { createRealtimeApp } from '../src/app';
import { serveRealtime } from '../src/serve';
import type { OutboxRowsSink } from '../src/outbox-drain';

const testServices = requireTestServices(process.env);
export const databaseUrl = testServices.databaseUrl;
const redisUrl = testServices.redisUrl;

/**
 * A real Bun.serve server on this test's own realtime app (its own env and
 * Redis namespace) against real PostgreSQL and Redis, bound to an ephemeral
 * port. Startup order (ADR 0032 §2) runs for real here: `startOutboxDrain`
 * is awaited before `Bun.serve`, exactly as `start.ts` sequences it, so
 * sockets are only ever accepted once LISTEN and the high-water mark read
 * have both completed.
 */
export async function bootServer(
  overrides: {
    readonly sink?: OutboxRowsSink;
    readonly pollIntervalMs?: number;
    readonly onQuery?: () => void;
    /** Observes a reconnect independent of database content or other listeners' traffic (RT-2.3b-f1 criterion 2). */
    readonly onListenWake?: () => void;
    /** Tags the drain connection so a test can find and kill it by name. */
    readonly applicationNameTag?: string;
  } = {},
) {
  const taggedUrl = overrides.applicationNameTag
    ? `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}application_name=${overrides.applicationNameTag}`
    : databaseUrl;
  const resources = createRealtimeApp({
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: taggedUrl,
      REDIS_URL: redisUrl,
      REDIS_NAMESPACE: testNamespace(systemId.next()),
      LOG_LEVEL: 'silent',
    },
    clock: systemClock,
  });
  const { server, drain } = await serveRealtime({
    resources,
    port: 0,
    hostname: '127.0.0.1',
    sink: overrides.sink ?? (() => {}),
    ...(overrides.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: overrides.pollIntervalMs }),
    ...(overrides.onQuery === undefined ? {} : { onQuery: overrides.onQuery }),
    ...(overrides.onListenWake === undefined
      ? {}
      : { onListenWake: overrides.onListenWake }),
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    drain,
    async close() {
      server.stop(true);
      await drain.stop();
      await resources.close();
    },
  };
}

export const waitFor = async (
  check: () => boolean,
  timeoutMs = 5000,
): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * Bypasses application validation to exercise the drain loop directly, as
 * packages/db's own outbox.integration.ts does, and returns once the row is
 * final (ISSUE-82): the drain reads a row only after every older
 * transaction in the cluster has ended, so a test that isolates one wake
 * path (a NOTIFY, a reconnect) with the poll switched off must not trigger
 * that wake while another database's transaction still holds the row back.
 */
export async function insertOutboxRow(
  client: SQL,
  input: { topic: string; kind: string; version: number; payload: unknown },
): Promise<{ txid: string; seq: bigint }> {
  const [row] = await client.unsafe(
    'insert into outbox (topic, kind, version, payload) values ($1, $2, $3, $4::jsonb) returning txid, seq',
    [input.topic, input.kind, input.version, input.payload],
  );
  const record = row as {
    txid: string | number | bigint;
    seq: string | number | bigint;
  };
  const position = { txid: String(record.txid), seq: BigInt(record.seq) };
  await waitForOutboxFinality(client, position.txid, { now: Date.now });
  return position;
}

export async function notifyOutbox(
  client: SQL,
  position: { txid: string; seq: bigint },
): Promise<void> {
  await client.unsafe('select pg_notify($1, $2)', [
    'outbox',
    `${position.txid}:${position.seq.toString()}`,
  ]);
}

/**
 * Commits `count` rows with distinct payloads in one transaction, waits
 * until they are final, then NOTIFYs each of them from one second
 * transaction: PostgreSQL folds identical NOTIFY payloads sent in the same
 * transaction into one delivery, so distinct payloads (a different
 * `entityVersion` per row) are what proves a real burst, not an artifact of
 * NOTIFY de-duplication. The notifications go out only once the rows are
 * final (ISSUE-82), so every wake they cause can read them.
 */
export async function insertAndNotifyBurst(
  client: SQL,
  topic: string,
  count: number,
): Promise<void> {
  const positions = await client.begin(async (tx) => {
    const inserted: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const [row] = await tx.unsafe(
        'insert into outbox (topic, kind, version, payload) values ($1, $2, $3, $4::jsonb) returning txid, seq',
        [
          topic,
          'room.changed',
          1,
          {
            entityVersion: index + 1,
            kind: 'room.changed',
            ids: [topic],
          },
        ],
      );
      const record = row as {
        txid: string | number | bigint;
        seq: string | number | bigint;
      };
      inserted.push(`${String(record.txid)}:${BigInt(record.seq).toString()}`);
    }
    return inserted;
  });
  const [txid] = (positions[0] ?? '').split(':');
  if (!txid) throw new Error('The burst inserted no rows');
  await waitForOutboxFinality(client, txid, { now: Date.now });
  await client.begin(async (tx) => {
    for (const position of positions) await tx.notify('outbox', position);
  });
}
