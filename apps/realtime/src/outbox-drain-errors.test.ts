import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { OUTBOX_ORIGIN, type OutboxRow } from '@offense-demo/db';
import { createOutboxDrainLoop } from './outbox-drain';
import {
  buildTestLoop,
  deferred,
  fakeRow,
  flush,
  noopLogger,
  recordingLogger,
  withUnhandledRejectionCheck,
} from './outbox-drain.test-support';

setupRitewayBun();

describe('createOutboxDrainLoop error recovery (RT-2.3b review finding 1)', () => {
  test('a rejecting drainOutbox query is caught, logged, and never crashes the loop; the next poll retries and succeeds', async () => {
    const { logger, events } = recordingLogger();
    let call = 0;
    const { loop } = buildTestLoop(async () => {
      call += 1;
      if (call === 1) throw new Error('connection reset');
      return [];
    }, logger);

    const { unhandled } = await withUnhandledRejectionCheck(async () => {
      loop.wake();
      await flush();
      loop.poll();
      await flush();
    });

    assert({
      given: 'a drainOutbox query that rejects once, then a poll that succeeds',
      should:
        'log the failure once, raise no unhandled rejection, and let the next poll deliver normally',
      actual: {
        callCount: call,
        loggedDrainFailure: events.includes('realtime.outbox.drain_failed'),
        unhandled,
        cursorAfter: loop.cursor(),
      },
      expected: {
        callCount: 2,
        loggedDrainFailure: true,
        unhandled: undefined,
        cursorAfter: OUTBOX_ORIGIN,
      },
    });
  });

  test('a throwing sink is caught, logged, and leaves the cursor at the last range the sink accepted, so the next wakeup retries the same range', async () => {
    const { logger, events } = recordingLogger();
    const row = fakeRow(1n);
    let sinkCalls = 0;
    const sink = (_rows: readonly OutboxRow[]) => {
      sinkCalls += 1;
      if (sinkCalls === 1) throw new Error('socket write failed');
    };
    const drainOutbox = async (): Promise<readonly OutboxRow[]> => [row];
    const loop = createOutboxDrainLoop({
      drainOutbox,
      sink,
      initialCursor: OUTBOX_ORIGIN,
      logger,
    });

    let cursorAfterFailure: unknown;
    const { unhandled } = await withUnhandledRejectionCheck(async () => {
      loop.wake();
      await flush();
      cursorAfterFailure = loop.cursor();
      loop.poll();
      await flush();
    });

    assert({
      given:
        'a sink that throws on its first call, then accepts the same row on retry',
      should:
        'never advance the cursor past a range the sink rejected, log the failure, and accept it once the sink succeeds',
      actual: {
        cursorAfterFailure,
        sinkCalls,
        cursorAfterRetry: loop.cursor(),
        loggedDrainFailure: events.includes('realtime.outbox.drain_failed'),
        unhandled,
      },
      expected: {
        cursorAfterFailure: OUTBOX_ORIGIN,
        sinkCalls: 2,
        cursorAfterRetry: { txid: row.txid, seq: row.seq },
        loggedDrainFailure: true,
        unhandled: undefined,
      },
    });
  });
});

describe('createOutboxDrainLoop sink/cursor tick (ADR 0032 §4, RT-2.3b-f1 criterion 1)', () => {
  test('the sink call and the cursor advance happen in the same synchronous tick, so nothing observes a cursor moved past rows the sink has not seen', async () => {
    const row = fakeRow(1n);
    let capturedCursorDuringHandoff: unknown;
    const loop = createOutboxDrainLoop({
      drainOutbox: async () => [row],
      sink: () => {
        // Queued from inside the synchronous sink call: if an `await`
        // separated the sink call from the cursor assignment, this
        // microtask (queued before that `await`'s own continuation) would
        // run first and observe the stale, pre-range cursor instead.
        queueMicrotask(() => {
          capturedCursorDuringHandoff = loop.cursor();
        });
      },
      initialCursor: OUTBOX_ORIGIN,
      logger: noopLogger,
    });

    loop.wake();
    await flush();

    assert({
      given:
        "a sink that queues a microtask, from inside its own synchronous call, to read the loop's cursor",
      should:
        'observe the cursor already advanced to this range, proving no await separates the sink call from the cursor assignment',
      actual: capturedCursorDuringHandoff,
      expected: { txid: row.txid, seq: row.seq },
    });
  });

  test('a synchronously throwing sink leaves the cursor unmoved, with the failure caught around the pass, not inside the tick', async () => {
    const row = fakeRow(1n);
    const { logger, events } = recordingLogger();
    const loop = createOutboxDrainLoop({
      drainOutbox: async () => [row],
      sink: () => {
        throw new Error('publish failed');
      },
      initialCursor: OUTBOX_ORIGIN,
      logger,
    });

    loop.wake();
    await flush();

    assert({
      given: 'a sink that throws synchronously on the only row available',
      should:
        'leave the cursor at the origin and log the failure, never partially advancing it',
      actual: {
        cursor: loop.cursor(),
        loggedDrainFailure: events.includes('realtime.outbox.drain_failed'),
      },
      expected: { cursor: OUTBOX_ORIGIN, loggedDrainFailure: true },
    });
  });
});

describe('createOutboxDrainLoop stop() (CodeRabbit RT-2.3b review finding 2)', () => {
  test('stop() waits for an in-flight pass to finish and ignores wakeups after stop() is called', async () => {
    let queryCount = 0;
    const gate = deferred<readonly OutboxRow[]>();
    const { loop } = buildTestLoop(async () => {
      queryCount += 1;
      return gate.promise;
    });

    loop.wake();
    await flush();
    const queriesWhilePending = queryCount;

    let stopResolved = false;
    const stopPromise = loop.stop().then(() => {
      stopResolved = true;
    });
    await flush();
    const stopResolvedWhilePassPending = stopResolved;

    // A wakeup arriving after stop() must never start a new pass.
    loop.wake();
    await flush();
    const queriesAfterPostStopWake = queryCount;

    gate.resolve([]);
    await stopPromise;

    assert({
      given:
        'stop() called while a pass is mid-query, followed by a wakeup after stop()',
      should:
        "not resolve stop() until the in-flight pass's query settles, and never start a new pass for a wakeup that arrives after stop()",
      actual: {
        queriesWhilePending,
        stopResolvedWhilePassPending,
        queriesAfterPostStopWake,
        stopResolvedAfterGateOpens: stopResolved,
      },
      expected: {
        queriesWhilePending: 1,
        stopResolvedWhilePassPending: false,
        queriesAfterPostStopWake: 1,
        stopResolvedAfterGateOpens: true,
      },
    });
  });
});
