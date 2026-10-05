import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { superviseRun } from './test-run-database';

setupRitewayBun();

/** A stand-in for the suite process: exits when told to, or when killed. */
function fakeProcess() {
  let finish: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const kills: string[] = [];
  return {
    exited,
    finish,
    kills,
    kill: () => {
      kills.push('killed');
      finish();
    },
  };
}

const tick = () => Promise.resolve();

describe('superviseRun (ISSUE-250)', () => {
  test('a run whose lock holds to the end simply exits', async () => {
    const proc = fakeProcess();
    let polls = 0;

    const verdict = superviseRun({
      exited: proc.exited,
      kill: proc.kill,
      lockLost: async () => false,
      sleep: async () => {
        polls += 1;
        if (polls === 3) proc.finish();
        await tick();
      },
    });

    assert({
      given: 'a suite that finishes after three polls with its lock intact',
      should: 'report exited and never kill it',
      actual: { verdict: await verdict, kills: proc.kills },
      expected: { verdict: 'exited', kills: [] },
    });
  });

  test('a lost lock stops the suite at once and reports lost', async () => {
    const proc = fakeProcess();
    let polls = 0;

    const verdict = await superviseRun({
      exited: proc.exited,
      kill: proc.kill,
      lockLost: async () => polls >= 2,
      sleep: async () => {
        polls += 1;
        await tick();
      },
    });

    assert({
      given:
        'a suite that never finishes and a lock session that is cut before the second poll',
      should: 'kill the suite and report lost, rather than run on unlocked',
      actual: { verdict, kills: proc.kills },
      expected: { verdict: 'lost', kills: ['killed'] },
    });
  });

  test('a lock lost in the last moments is still caught after the suite exits', async () => {
    const proc = fakeProcess();

    const verdict = await superviseRun({
      exited: proc.exited,
      kill: proc.kill,
      lockLost: async () => true,
      sleep: async () => {
        proc.finish();
        await tick();
      },
    });

    assert({
      given: 'a suite that exits on its own but whose lock was already gone',
      should: 'report lost, so the run fails loudly instead of passing',
      actual: verdict,
      expected: 'lost',
    });
  });

  test('ISSUE-272: a run that outlasts the run bound is killed and reported as too long', async () => {
    const proc = fakeProcess();
    let clock = 0;

    const verdict = await superviseRun({
      exited: proc.exited,
      kill: proc.kill,
      lockLost: async () => false,
      maxRunMs: 1_000,
      now: () => clock,
      sleep: async () => {
        clock += 400;
        await tick();
      },
    });

    assert({
      given:
        'a suite that never finishes, a one-second bound and a clock that advances 400 ms per poll',
      should:
        'kill it on the third poll (1,200 ms) and report timeout, so no run outlives the bound its sweep protects',
      actual: { verdict, kills: proc.kills, clock },
      expected: { verdict: 'timeout', kills: ['killed'], clock: 1_200 },
    });
  });

  test('ISSUE-272 negative control: a run inside the bound is not cut short', async () => {
    const proc = fakeProcess();
    let clock = 0;

    const verdict = await superviseRun({
      exited: proc.exited,
      kill: proc.kill,
      lockLost: async () => false,
      maxRunMs: 10_000,
      now: () => clock,
      sleep: async () => {
        clock += 400;
        if (clock >= 1_200) proc.finish();
        await tick();
      },
    });

    assert({
      given: 'a suite that finishes at 1,200 ms with a ten-second bound',
      should: 'report exited and never kill it',
      actual: { verdict, kills: proc.kills },
      expected: { verdict: 'exited', kills: [] },
    });
  });
});
