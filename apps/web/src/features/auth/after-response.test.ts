import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Logger } from '@offense-demo/logger';
import { silentLogger } from '../../server/test-loggers.test-support';
import {
  AFTER_RESPONSE_MAX_QUEUED,
  AFTER_RESPONSE_MAX_RUNNING,
  createAfterResponse,
} from './after-response';

setupRitewayBun();

/** A promise and the function that resolves it. */
const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

describe('createAfterResponse', () => {
  test('starts the work a request queued only once its handler has returned', async () => {
    const steps: string[] = [];
    const { defer, around, settled } = createAfterResponse(silentLogger);
    const answer = await around(async () => {
      defer(async () => void steps.push('work'));
      await Promise.resolve();
      steps.push('answered');
      return 'answer';
    });
    await settled();
    assert({
      given: 'work queued in the middle of a request',
      should: 'run it after the request has produced its answer',
      actual: { answer, steps },
      expected: { answer: 'answer', steps: ['answered', 'work'] },
    });
  });

  test('still starts queued work when the handler throws', async () => {
    const steps: string[] = [];
    const { defer, around, settled } = createAfterResponse(silentLogger);
    const failure = await around(async () => {
      defer(async () => void steps.push('work'));
      throw new Error('handler failed');
    }).catch((error: unknown) => (error as Error).message);
    await settled();
    assert({
      given: 'a request that queues work and then throws',
      should: 'rethrow the failure and still run the queued work',
      actual: { failure, steps },
      expected: { failure: 'handler failed', steps: ['work'] },
    });
  });

  test('does not make a direct caller wait on work queued outside a request', async () => {
    const { opened, open } = gate();
    const steps: string[] = [];
    const { defer, settled } = createAfterResponse(silentLogger);
    defer(async () => {
      await opened;
      steps.push('work');
    });
    steps.push('caller continued');
    open();
    await settled();
    assert({
      given: 'work queued with no request in progress',
      should: 'start it without the caller waiting on it',
      actual: steps,
      expected: ['caller continued', 'work'],
    });
  });

  test('settles only once every started piece of work has finished', async () => {
    const { opened, open } = gate();
    const { defer, around, settled } = createAfterResponse(silentLogger);
    let finished = false;
    await around(async () =>
      defer(async () => {
        await opened;
        finished = true;
      }),
    );
    const settling = settled().then(() => finished);
    open();
    assert({
      given: 'work still waiting when settled() is called',
      should: 'resolve settled() after that work has finished',
      actual: await settling,
      expected: true,
    });
  });

  test('logs a failed piece of work instead of rejecting unhandled', async () => {
    const logged: unknown[][] = [];
    const logger: Logger = {
      log: (...entry) => void logged.push(entry),
      child: () => logger,
    };
    const { defer, around, settled } = createAfterResponse(logger);
    await around(async () =>
      defer(async () => {
        throw new Error('lookup failed');
      }),
    );
    await settled();
    assert({
      given: 'queued work that rejects',
      should: 'log request.unhandled once, without the error',
      actual: logged,
      expected: [
        [
          'request.unhandled',
          { source: 'auth.after-response' },
          'Authentication work after the answer failed',
        ],
      ],
    });
  });

  test('holds at most the bound and sheds, logs and never starts what arrives past it', async () => {
    const { opened, open } = gate();
    const logged: unknown[][] = [];
    const logger: Logger = {
      log: (...entry) => void logged.push(entry),
      child: () => logger,
    };
    const { defer, settled, pending } = createAfterResponse(logger);
    const bound = AFTER_RESPONSE_MAX_RUNNING + AFTER_RESPONSE_MAX_QUEUED;
    let started = 0;
    let peak = 0;
    for (let index = 0; index < bound + 10; index += 1) {
      defer(async () => {
        started += 1;
        await opened;
      });
      peak = Math.max(peak, pending());
    }
    await Promise.resolve();
    const runningAtOnce = started;
    open();
    await settled();
    assert({
      given: `${bound + 10} pieces of work handed off while none can finish`,
      should: `run ${AFTER_RESPONSE_MAX_RUNNING} at once, hold at most ${bound}, shed 10 with a count-only log line, and run the held ones once they can`,
      actual: {
        runningAtOnce,
        peak,
        started,
        pendingAfter: pending(),
        shed: logged.filter(([event]) => event === 'auth.mail.shed'),
      },
      expected: {
        runningAtOnce: AFTER_RESPONSE_MAX_RUNNING,
        peak: bound,
        started: bound,
        pendingAfter: 0,
        shed: Array.from({ length: 10 }, () => [
          'auth.mail.shed',
          { operation: 'auth.after-response', pending: bound },
          'Auth work after the answer was shed; its backlog is full',
        ]),
      },
    });
  });

  test('queues database steps only behind the gate, never more than the tasks holding a slot', async () => {
    const { opened, open } = gate();
    const limits = { maxRunning: 6, maxQueued: 3, dbSteps: 2 };
    const { defer, settled, pending, dbStep, dbSteps } = createAfterResponse(
      silentLogger,
      limits,
    );
    let stepping = 0;
    let steppingPeak = 0;
    for (let index = 0; index < 20; index += 1)
      defer(() =>
        dbStep(async () => {
          stepping += 1;
          steppingPeak = Math.max(steppingPeak, stepping);
          await opened;
          stepping -= 1;
        }),
      );
    await Promise.resolve();
    await Promise.resolve();
    const held = { pending: pending(), steps: dbSteps() };
    open();
    await settled();
    assert({
      given:
        '20 pieces of work, each one database step that cannot finish yet, with 6 slots, 3 waiting and a gate of 2',
      should:
        'hold 9, run 2 steps at once, and queue no more steps than the 6 slot holders',
      actual: { ...held, steppingPeak, after: dbSteps() },
      expected: { pending: 9, steps: 6, steppingPeak: 2, after: 0 },
    });
  });
});
