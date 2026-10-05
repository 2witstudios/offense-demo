import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { startRetentionSweep } from './retention-sweep';

setupRitewayBun();

describe('retention sweep schedule', () => {
  const fakeTimers = () => {
    const state: { tick?: () => unknown; cleared: unknown[]; ms?: number } = {
      cleared: [],
    };
    return {
      state,
      timers: {
        setInterval: (tick: () => unknown, ms: number) => {
          state.tick = tick;
          state.ms = ms;
          return 'retention-timer';
        },
        clearInterval: (handle: unknown) => void state.cleared.push(handle),
      },
    };
  };
  const gatedSweep = () => {
    const state = { started: 0, stopped: false, release: () => {} };
    return {
      state,
      sweep: {
        run: () => {
          state.started += 1;
          return new Promise<[]>((resolve) => {
            state.release = () => resolve([]);
          });
        },
        stop: () => {
          state.stopped = true;
        },
      },
    };
  };

  test('runs on start, reschedules hourly, skips a tick that overlaps a run, and runs again after it', async () => {
    const { state, timers } = fakeTimers();
    const gated = gatedSweep();
    const schedule = startRetentionSweep({
      sweep: gated.sweep,
      timers,
      runOnStart: true,
    });
    const overlapping = state.tick?.();
    const duringStartUp = gated.state.started;
    gated.state.release();
    await schedule.initial;
    const nextTick = state.tick?.();
    gated.state.release();
    await nextTick;
    assert({
      given: 'runOnStart, a tick during the start-up run, then a later tick',
      should:
        'run once at start, skip the overlapping tick, run the later one, on an hourly interval',
      actual: {
        duringStartUp,
        overlapping,
        started: gated.state.started,
        ms: state.ms,
      },
      expected: {
        duringStartUp: 1,
        overlapping: undefined,
        started: 2,
        ms: 3_600_000,
      },
    });
  });

  test('the start-up run waits for waitUntilReady before sweeping, never before (ISSUE-146)', async () => {
    const { timers } = fakeTimers();
    const gated = gatedSweep();
    let releaseReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const schedule = startRetentionSweep({
      sweep: gated.sweep,
      timers,
      runOnStart: true,
      waitUntilReady: () => ready.then(() => true),
    });
    // Drain microtasks: nothing has run yet because waitUntilReady has not
    // resolved (a cold Fly boot's Redis connection not answering yet).
    for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    const beforeReady = gated.state.started;
    releaseReady();
    // Let the now-unblocked waitUntilReady microtask run tick(), which
    // calls sweep.run(); only then is there a run to release.
    for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    gated.state.release();
    await schedule.initial;
    assert({
      given:
        'a start-up run gated on waitUntilReady, which has not resolved yet',
      should: 'start no sweep until it resolves, then run exactly once',
      actual: { beforeReady, afterReady: gated.state.started },
      expected: { beforeReady: 0, afterReady: 1 },
    });
  });

  test('a start-up wait that reports not-ready or rejects skips the start-up run, leaving the hourly schedule (ISSUE-146)', async () => {
    const outcomes = await Promise.all(
      [
        () => Promise.resolve(false),
        () => Promise.reject(new Error('redis down')),
      ].map(async (waitUntilReady) => {
        const { state, timers } = fakeTimers();
        const gated = gatedSweep();
        const schedule = startRetentionSweep({
          sweep: gated.sweep,
          timers,
          runOnStart: true,
          waitUntilReady,
        });
        await schedule.initial;
        const startUpRuns = gated.state.started;
        const nextTick = state.tick?.();
        gated.state.release();
        await nextTick;
        return { startUpRuns, afterTick: gated.state.started };
      }),
    );
    assert({
      given:
        'a start-up wait that resolves false (Redis never healthy), and one that rejects',
      should:
        'run no start-up sweep, settle without throwing, and still run the next hourly tick',
      actual: outcomes,
      expected: [
        { startUpRuns: 0, afterTick: 1 },
        { startUpRuns: 0, afterTick: 1 },
      ],
    });
  });

  test('stop clears the timer, stops the sweep, waits for the run in progress and starts no new run', async () => {
    const { state, timers } = fakeTimers();
    const gated = gatedSweep();
    const schedule = startRetentionSweep({ sweep: gated.sweep, timers });
    void state.tick?.();
    let settled = false;
    const stopping = schedule.stop().then(() => {
      settled = true;
    });
    // Drain the microtask queue (no timers): a stop that did not wait for
    // the run would already have resolved by now.
    for (let hop = 0; hop < 10; hop += 1) await Promise.resolve();
    const beforeRelease = { settled, stopped: gated.state.stopped };
    const afterStopTick = state.tick?.();
    gated.state.release();
    await stopping;
    assert({
      given: 'a stop while a sweep run is still deleting',
      should:
        'stop the sweep, resolve only once that run ends, clear the timer and start no new run',
      actual: {
        beforeRelease,
        settled,
        cleared: state.cleared,
        started: gated.state.started,
        afterStopTick,
      },
      expected: {
        beforeRelease: { settled: false, stopped: true },
        settled: true,
        cleared: ['retention-timer'],
        started: 1,
        afterStopTick: undefined,
      },
    });
  });
});
