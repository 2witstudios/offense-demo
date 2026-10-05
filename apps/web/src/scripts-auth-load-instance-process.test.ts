import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { wireInstanceLifecycle } from '../scripts/auth-load/instance-process';
import { instanceSpawnOptions } from '../scripts/auth-load/two-instances';

setupRitewayBun();

/**
 * ISSUE-151: proves the real wiring `instance-process.ts` runs (not a copy
 * of its logic elsewhere) — the gap the ISSUE-150 real-process test left,
 * since that test only exercised an inline reimplementation. Importing
 * this module never runs it: `wireInstanceLifecycle` only fires under
 * `import.meta.main`, which is false here.
 */
describe('instance-process.ts wireInstanceLifecycle (ISSUE-150/151)', () => {
  test('installs a 3000ms forced shutdown and watches the real process stdin, by default', () => {
    let forceShutdownArgs: unknown;
    let watchLivenessArgs: unknown;
    wireInstanceLifecycle({
      forceShutdown: (args) => void (forceShutdownArgs = args),
      watchLiveness: (args) => void (watchLivenessArgs = args),
    });
    assert({
      given: 'the real instance-process.ts wiring, called with its defaults',
      should:
        'install a 3000ms forced shutdown and a parent-liveness watch on the real process stdin',
      actual: {
        drainBudgetMs: (forceShutdownArgs as { drainBudgetMs?: number })
          ?.drainBudgetMs,
        watchesRealStdin:
          (watchLivenessArgs as { stdin?: unknown })?.stdin === process.stdin,
      },
      expected: { drainBudgetMs: 3000, watchesRealStdin: true },
    });
  });

  test('exits the same way on a forced-shutdown exit and on the parent going away', () => {
    const exitCodes: number[] = [];
    let onParentGone: (() => void) | undefined;
    wireInstanceLifecycle({
      exit: (code) => exitCodes.push(code),
      forceShutdown: () => {},
      watchLiveness: (args) => void (onParentGone = args.onParentGone),
    });
    onParentGone?.();
    assert({
      given: "the parent-liveness watch's onParentGone callback firing",
      should: 'exit 0 through the same exit function the forced shutdown uses',
      actual: exitCodes,
      expected: [0],
    });
  });

  test('forwards a custom drain budget and target to the forced-shutdown seam', () => {
    let forceShutdownArgs: unknown;
    const target = { once: () => {} };
    wireInstanceLifecycle({
      drainBudgetMs: 500,
      target: target as never,
      forceShutdown: (args) => void (forceShutdownArgs = args),
      watchLiveness: () => {},
    });
    assert({
      given: 'an explicit drainBudgetMs and target',
      should: 'pass both through to the forced-shutdown seam unchanged',
      actual: {
        drainBudgetMs: (forceShutdownArgs as { drainBudgetMs?: number })
          ?.drainBudgetMs,
        target: (forceShutdownArgs as { target?: unknown })?.target,
      },
      expected: { drainBudgetMs: 500, target },
    });
  });
});

describe('two-instances.ts instanceSpawnOptions (ISSUE-150/151)', () => {
  test('spawns each instance with stdin piped, never inherited or ignored', () => {
    const options = instanceSpawnOptions(3000, 4000, {});
    assert({
      given:
        'the real spawn options startTwoInstances gives each instance process',
      should:
        "pipe stdin so the instance's watchParentLiveness sees the parent driver's EOF",
      actual: options.stdin,
      expected: 'pipe',
    });
  });
});
