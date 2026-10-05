import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  OUTBOX_ORIGIN,
  type OutboxPosition,
  type OutboxRow,
} from '@offense-demo/db';
import { startOutboxDrain, type IntervalTimers } from './outbox-drain';
import {
  buildTestLoop,
  deferred,
  fakeRow,
  flush,
  noopLogger,
} from './outbox-drain.test-support';

setupRitewayBun();

describe('createOutboxDrainLoop coalescing (ADR 0032 §3)', () => {
  test('wakeups that arrive while a pass is in flight only re-arm the dirty flag, never spawning a second query mid-pass', async () => {
    let queryCount = 0;
    const pending: Array<{ resolve: (rows: readonly OutboxRow[]) => void }> =
      [];
    const { loop } = buildTestLoop(async () => {
      queryCount += 1;
      const d = deferred<readonly OutboxRow[]>();
      pending.push(d);
      return d.promise;
    });

    loop.wake();
    const queriesAfterFirstWake = queryCount;
    loop.wake();
    loop.wake();
    loop.wake();
    const queriesAfterBurst = queryCount;

    pending[0]?.resolve([]);
    await flush();
    await flush();
    const queriesAfterFirstResolve = queryCount;

    pending[1]?.resolve([]);
    await flush();
    await flush();

    assert({
      given:
        'one wakeup starting a query, then three more wakeups arriving while that query is still pending',
      should:
        'issue exactly one query for the first wakeup, coalesce the burst into a single rerun once the first query returns, then settle',
      actual: {
        queriesAfterFirstWake,
        queriesAfterBurst,
        queriesAfterFirstResolve,
        finalQueryCount: queryCount,
      },
      expected: {
        queriesAfterFirstWake: 1,
        queriesAfterBurst: 1,
        queriesAfterFirstResolve: 2,
        finalQueryCount: 2,
      },
    });
  });

  test('poll runs a pass even when nothing is dirty, since the poll is the correctness mechanism', async () => {
    let queryCount = 0;
    const { loop } = buildTestLoop(async () => {
      queryCount += 1;
      return [];
    });

    loop.poll();
    await flush();

    assert({
      given: 'a poll wakeup with no prior NOTIFY and nothing dirty',
      should: 'still issue a range query',
      actual: queryCount,
      expected: 1,
    });
  });

  test('a full-width range (500 rows) is followed immediately by another query in the same pass, without waiting for a new wakeup', async () => {
    let queryCount = 0;
    const calls: OutboxPosition[] = [];
    const fullRange: readonly OutboxRow[] = Array.from(
      { length: 500 },
      (_, i) => fakeRow(BigInt(i + 1)),
    );
    const { loop, delivered } = buildTestLoop(async (cursor) => {
      queryCount += 1;
      calls.push(cursor);
      return queryCount === 1 ? fullRange : [];
    });

    loop.wake();
    await flush();
    await flush();

    assert({
      given: 'a first range that comes back exactly at the 500-row limit',
      should:
        'query again immediately in the same pass, advancing the cursor to the last delivered row',
      actual: {
        queryCount,
        deliveredBatches: delivered.length,
        secondQueryCursor: calls[1],
        finalCursor: loop.cursor(),
      },
      expected: {
        queryCount: 2,
        deliveredBatches: 1,
        secondQueryCursor: { txid: '1', seq: 500n },
        finalCursor: { txid: '1', seq: 500n },
      },
    });
  });
});

describe('startOutboxDrain startup order (ADR 0032 §2)', () => {
  test('reads the high-water mark only after LISTEN resolves, and accepts a reconnect wake that arrives before the loop exists', async () => {
    const order: string[] = [];
    const listenAck = deferred<void>();
    let capturedOnListen: (() => void) | undefined;
    const database = {
      async listenOutbox(handlers: {
        onNotify: (position: string) => void;
        onListen: () => void;
      }) {
        order.push('listen:called');
        capturedOnListen = handlers.onListen;
        await listenAck.promise;
        order.push('listen:acked');
        return { unlisten: async () => {} };
      },
      async readOutboxHighWaterMark(): Promise<OutboxPosition> {
        order.push('highWaterMark:read');
        return { txid: '5', seq: 9n };
      },
      async drainOutbox(): Promise<readonly OutboxRow[]> {
        order.push('drain:queried');
        return [];
      },
    };

    const startPromise = startOutboxDrain({
      database,
      sink: () => {},
      logger: noopLogger,
      timers: { setInterval: () => 0 as never, clearInterval: () => {} },
    });

    await flush();
    // A reconnect-shaped wake fires before the loop is constructed; it must
    // be buffered, not dropped.
    capturedOnListen?.();
    listenAck.resolve();

    const control = await startPromise;
    await flush();
    await flush();

    assert({
      given:
        'LISTEN acknowledging asynchronously, with an onListen wake arriving before the high-water mark is read',
      should:
        'read the high-water mark only after LISTEN acks, seed the cursor from it, and replay the buffered wake once the loop exists',
      actual: {
        order: order.filter((entry) => entry !== 'drain:queried'),
        drainQueriedAtLeastOnce: order.includes('drain:queried'),
        cursor: control.cursor(),
      },
      expected: {
        order: ['listen:called', 'listen:acked', 'highWaterMark:read'],
        drainQueriedAtLeastOnce: true,
        cursor: { txid: '5', seq: 9n },
      },
    });
  });

  test('wires the 1 s poll through the injected interval timers and stops it, and unlistens, on stop()', async () => {
    let intervalCallback: (() => void) | undefined;
    let intervalMs: number | undefined;
    let cleared = false;
    let unlistened = false;
    const timers: IntervalTimers = {
      setInterval: (callback, ms) => {
        intervalCallback = callback;
        intervalMs = ms;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        cleared = true;
      },
    };
    let drainCount = 0;
    const database = {
      async listenOutbox() {
        return {
          unlisten: async () => {
            unlistened = true;
          },
        };
      },
      async readOutboxHighWaterMark(): Promise<OutboxPosition> {
        return OUTBOX_ORIGIN;
      },
      async drainOutbox(): Promise<readonly OutboxRow[]> {
        drainCount += 1;
        return [];
      },
    };

    const control = await startOutboxDrain({
      database,
      sink: () => {},
      logger: noopLogger,
      pollIntervalMs: 1_000,
      timers,
    });
    const drainCountBeforeTick = drainCount;
    intervalCallback?.();
    await flush();

    await control.stop();

    assert({
      given: 'a running drain wired to injected interval timers',
      should:
        'schedule the 1 s poll through the timers, run a pass on each tick, and clear the interval and unlisten on stop',
      actual: {
        intervalMs,
        drainCountBeforeTick,
        drainCountAfterTick: drainCount,
        cleared,
        unlistened,
      },
      expected: {
        intervalMs: 1_000,
        drainCountBeforeTick: 0,
        drainCountAfterTick: 1,
        cleared: true,
        unlistened: true,
      },
    });
  });

  test('unlistens and rethrows when the high-water mark read fails after LISTEN has resolved (CodeRabbit RT-2.3b review finding 4)', async () => {
    let unlistened = false;
    const database = {
      async listenOutbox() {
        return {
          unlisten: async () => {
            unlistened = true;
          },
        };
      },
      async readOutboxHighWaterMark(): Promise<OutboxPosition> {
        throw new Error('connection reset');
      },
      async drainOutbox(): Promise<readonly OutboxRow[]> {
        return [];
      },
    };

    let caught: unknown;
    try {
      await startOutboxDrain({
        database,
        sink: () => {},
        logger: noopLogger,
        timers: { setInterval: () => 0 as never, clearInterval: () => {} },
      });
    } catch (error) {
      caught = error;
    }

    assert({
      given:
        'a LISTEN subscription that resolves, followed by a high-water-mark read that rejects',
      should:
        'unlisten the dedicated LISTEN connection before rethrowing the original error, so it never outlives this call',
      actual: {
        unlistened,
        caughtMessage: caught instanceof Error ? caught.message : caught,
      },
      expected: { unlistened: true, caughtMessage: 'connection reset' },
    });
  });
});
