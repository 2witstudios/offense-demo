import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock } from '@offense-demo/clock';
import { createRetentionSweep, type RetentionTarget } from './retention-sweep';
import { createRecordingLogger } from './test-loggers.test-support';

setupRitewayBun();

// ISSUE-8 AC5: the sweep's run behaviour is tested here; the production
// target list is retention-targets.test.ts and the schedule wrapper is
// retention-schedule.test.ts, each once.
const now = '2026-09-20T12:00:00.000Z';

type Logged = { event: string; fields: unknown };
const recorder = () => {
  const { recorded: logged, logger } = createRecordingLogger();
  return { logged, logger };
};
const events = (logged: Logged[]) =>
  logged.map(({ event, fields }) => [event, fields]);

const target = (
  name: string,
  answers: Array<number | Error>,
  { batchSize = 3, maxBatches = 10 } = {},
) => {
  const calls: Array<{ now: string; limit: number }> = [];
  const spec: RetentionTarget = {
    name,
    batchSize,
    maxBatches,
    purge: async (input) => {
      calls.push(input);
      const next = answers.shift() ?? 0;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { spec, calls };
};

describe('retention sweep run', () => {
  test('drains each target in bounded batches until a short batch, and logs counts only', async () => {
    const first = target('retention.first', [3, 3, 1]);
    const second = target('retention.second', [2]);
    const { logged, logger } = recorder();
    const sweep = createRetentionSweep({
      targets: [first.spec, second.spec],
      clock: fixedClock(now),
      logger,
    });
    const results = await sweep.run();
    assert({
      given:
        'a first target with a backlog of 7 and a second with 2, batch size 3',
      should:
        'call each target with the run’s clock and its batch size until a short batch, and log one completed event per target',
      actual: {
        results,
        firstCalls: first.calls,
        secondCalls: second.calls,
        logged: events(logged),
      },
      expected: {
        results: [
          { operation: 'retention.first', ok: true, deleted: 7, batches: 3 },
          { operation: 'retention.second', ok: true, deleted: 2, batches: 1 },
        ],
        firstCalls: Array(3).fill({ now, limit: 3 }),
        secondCalls: [{ now, limit: 3 }],
        logged: [
          [
            'retention.sweep.completed',
            { operation: 'retention.first', deleted: 7, batches: 3 },
          ],
          [
            'retention.sweep.completed',
            { operation: 'retention.second', deleted: 2, batches: 1 },
          ],
        ],
      },
    });
  });

  test('a target is bounded by its maxBatches even when rows keep arriving', async () => {
    const endless = target('retention.endless', Array(10).fill(2), {
      batchSize: 2,
      maxBatches: 4,
    });
    const { logger } = recorder();
    const [result] = await createRetentionSweep({
      targets: [endless.spec],
      clock: fixedClock(now),
      logger,
    }).run();
    assert({
      given: 'a target that always returns full batches and a cap of 4',
      should: 'stop at the batch cap and report it; the rest drains next run',
      actual: { calls: endless.calls.length, result },
      expected: {
        calls: 4,
        result: {
          operation: 'retention.endless',
          ok: true,
          deleted: 8,
          batches: 4,
        },
      },
    });
  });

  test('a failing target logs a stable code with no payload, keeps its partial count, and never stops the next target', async () => {
    const failing = target('retention.failing', [
      3,
      new Error('delete from outbox where topic = room:secret-id'),
    ]);
    const next = target('retention.next', [1]);
    const { logged, logger } = recorder();
    const results = await createRetentionSweep({
      targets: [failing.spec, next.spec],
      clock: fixedClock(now),
      logger,
    }).run();
    assert({
      given:
        'a target that deletes one full batch and then throws an error carrying a topic, followed by a healthy target',
      should:
        'report ok:false with the rows that did go, log only a stable code, and still sweep the next target',
      actual: {
        results,
        logged: events(logged),
        leaked: JSON.stringify(logged).includes('secret-id'),
      },
      expected: {
        results: [
          { operation: 'retention.failing', ok: false, deleted: 3, batches: 1 },
          { operation: 'retention.next', ok: true, deleted: 1, batches: 1 },
        ],
        logged: [
          [
            'retention.sweep.failed',
            { operation: 'retention.failing', errorCode: 'INFRASTRUCTURE' },
          ],
          [
            'retention.sweep.completed',
            { operation: 'retention.next', deleted: 1, batches: 1 },
          ],
        ],
        leaked: false,
      },
    });
  });

  test('stop ends the run between batches: the batch in flight finishes and no later batch or target starts', async () => {
    const { logged, logger } = recorder();
    const later = target('retention.later', [1]);
    let calls = 0;
    const sweep = createRetentionSweep({
      targets: [
        {
          name: 'retention.stopped',
          batchSize: 3,
          maxBatches: 10,
          purge: async () => {
            calls += 1;
            sweep.stop();
            return 3;
          },
        },
        later.spec,
      ],
      clock: fixedClock(now),
      logger,
    });
    const results = await sweep.run();
    assert({
      given: 'a stop requested while the first target’s first full batch runs',
      should:
        'finish that batch, start no more batches or targets, and complete normally with its counts',
      actual: {
        calls,
        laterCalls: later.calls.length,
        results,
        events: logged.map(({ event }) => event),
      },
      expected: {
        calls: 1,
        laterCalls: 0,
        results: [
          { operation: 'retention.stopped', ok: true, deleted: 3, batches: 1 },
        ],
        events: ['retention.sweep.completed'],
      },
    });
  });
});
