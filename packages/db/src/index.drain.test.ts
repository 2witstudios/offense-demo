import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestDatabase, type SinkEvent } from './index.test-support';

setupRitewayBun();

describe('RT-2.3b drain surface on createDatabase()', () => {
  test('drainOutbox and readOutboxHighWaterMark are bound to this instance, never requiring the caller to hold a Drizzle handle', async () => {
    const { database } = createTestDatabase([[{ txid: '9', seq: '3' }], []]);

    const highWaterMark = await database.readOutboxHighWaterMark();
    const rows = await database.drainOutbox({ txid: '0', seq: 0n }, 10);

    assert({
      given: "createDatabase()'s own bound outbox reads",
      should: 'run the query through this instance and return decoded results',
      actual: { highWaterMark, rows },
      expected: { highWaterMark: { txid: '9', seq: 3n }, rows: [] },
    });
  });

  test('reports a failed drainOutbox through the injected event sink', async () => {
    const events: SinkEvent[] = [];
    const { database } = createTestDatabase(
      [new Error('drain failed')],
      events,
    );

    await expect(
      database.drainOutbox({ txid: '0', seq: 0n }, 10),
    ).rejects.toThrow('Failed query');

    assert({
      given: 'a drainOutbox query that fails',
      should: 'emit db.query.failed naming the operation',
      actual: events.map((event) => ({
        event: event.event,
        operation: event.fields.operation,
      })),
      expected: [{ event: 'db.query.failed', operation: 'drainOutbox' }],
    });
  });

  test('listenOutbox subscribes to the outbox channel and returns an unlisten handle', async () => {
    const { database } = createTestDatabase([]);
    let notified: string | undefined;
    let listened = false;

    const subscription = await database.listenOutbox({
      onNotify: (position) => {
        notified = position;
      },
      onListen: () => {
        listened = true;
      },
    });
    await subscription.unlisten();

    assert({
      given: 'a subscription to the outbox LISTEN channel',
      should:
        'resolve to an unlisten handle without invoking either handler on its own',
      actual: {
        notified,
        listened,
        hasUnlisten: typeof subscription.unlisten,
      },
      expected: {
        notified: undefined,
        listened: false,
        hasUnlisten: 'function',
      },
    });
  });
});
