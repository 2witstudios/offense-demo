import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  installForcedShutdown,
  watchParentLiveness,
} from './process-lifecycle';

setupRitewayBun();

/** A fake `process`-shaped target recording the listener registered per signal. */
const fakeSignalTarget = () => {
  const handlers: Record<string, () => void> = {};
  return {
    once: (signal: string, handler: () => void) =>
      void (handlers[signal] = handler),
    fire: (signal: string) => handlers[signal]?.(),
  };
};

describe('installForcedShutdown (ISSUE-150)', () => {
  test('registers a forced-exit handler for SIGTERM and SIGINT by default', () => {
    const registered: string[] = [];
    const target = { once: (signal: string) => void registered.push(signal) };
    installForcedShutdown({
      drainBudgetMs: 1000,
      exit: () => {},
      target: target as never,
    });
    assert({
      given: 'no explicit signal list',
      should: 'register a forced-exit handler for SIGTERM and SIGINT',
      actual: registered.sort(),
      expected: ['SIGINT', 'SIGTERM'],
    });
  });

  test('schedules a hard exit(0) at the configured drain budget on SIGTERM', () => {
    const target = fakeSignalTarget();
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    const exitCodes: number[] = [];
    installForcedShutdown({
      drainBudgetMs: 3000,
      exit: (code) => exitCodes.push(code),
      target: target as never,
      schedule: (callback, ms) => scheduled.push({ callback, ms }),
    });
    target.fire('SIGTERM');
    scheduled[0]?.callback();
    assert({
      given: 'a SIGTERM delivered to a registered target',
      should:
        'schedule the exit at the configured drain budget and then exit 0',
      actual: { scheduledMs: scheduled[0]?.ms, exitCodes },
      expected: { scheduledMs: 3000, exitCodes: [0] },
    });
  });

  test('SIGINT forces the same bounded exit', () => {
    const target = fakeSignalTarget();
    const exitCodes: number[] = [];
    installForcedShutdown({
      drainBudgetMs: 5,
      exit: (code) => exitCodes.push(code),
      target: target as never,
      schedule: (callback) => callback(),
    });
    target.fire('SIGINT');
    assert({
      given: 'a SIGINT delivered to a registered target',
      should: 'exit 0 the same way SIGTERM does',
      actual: exitCodes,
      expected: [0],
    });
  });
});

describe('watchParentLiveness (ISSUE-150)', () => {
  const fakeStdin = () => {
    const listeners: Record<'end' | 'close', Array<() => void>> = {
      end: [],
      close: [],
    };
    let resumed = 0;
    return {
      on: (event: 'end' | 'close', listener: () => void) => {
        listeners[event].push(listener);
      },
      resume: () => void (resumed += 1),
      emit: (event: 'end' | 'close') => {
        for (const listener of listeners[event]) listener();
      },
      resumedCount: () => resumed,
    };
  };

  test('exits once the parent stdin pipe ends', () => {
    const stdin = fakeStdin();
    let gone = 0;
    watchParentLiveness({ stdin, onParentGone: () => void (gone += 1) });
    stdin.emit('end');
    assert({
      given: "the parent's stdin pipe closing (parent process exited)",
      should: 'call onParentGone exactly once',
      actual: gone,
      expected: 1,
    });
  });

  test('exits once the parent stdin pipe closes, even without a prior end', () => {
    const stdin = fakeStdin();
    let gone = 0;
    watchParentLiveness({ stdin, onParentGone: () => void (gone += 1) });
    stdin.emit('close');
    assert({
      given: "the parent's stdin pipe closing without a prior 'end'",
      should: 'call onParentGone exactly once',
      actual: gone,
      expected: 1,
    });
  });

  test('never fires onParentGone twice when both end and close arrive', () => {
    const stdin = fakeStdin();
    let gone = 0;
    watchParentLiveness({ stdin, onParentGone: () => void (gone += 1) });
    stdin.emit('end');
    stdin.emit('close');
    assert({
      given: 'both end and close events on the same stdin pipe',
      should: 'call onParentGone exactly once, not twice',
      actual: gone,
      expected: 1,
    });
  });

  test('resumes the stream so a paused stdin actually emits its events', () => {
    const stdin = fakeStdin();
    watchParentLiveness({ stdin, onParentGone: () => {} });
    assert({
      given: 'a freshly wired stdin watch',
      should: 'resume the stream once, since an unread stdin never emits end',
      actual: stdin.resumedCount(),
      expected: 1,
    });
  });
});
