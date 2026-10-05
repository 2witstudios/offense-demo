import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  create,
  existingAccount,
  magicLinkRequest,
} from './abuse.test-support';

setupRitewayBun();

const saturated = () =>
  create({
    stepDelayMs: 3,
    afterResponseLimits: { maxRunning: 16, maxQueued: 0, dbSteps: 1 },
    limiter: () => async (key) =>
      key.startsWith('auth:magic-link:global:')
        ? { allowed: false, retryAfterSeconds: 30 }
        : { allowed: true, retryAfterSeconds: 0 },
  });

/** Three sign-ins (lookup, suppression read, receipt write) and three sign-ups (lookup, token delete). */
const requests = () => [
  ...Array.from({ length: 3 }, () => magicLinkRequest()),
  ...Array.from({ length: 3 }, (_, index) =>
    magicLinkRequest({}, `newcomer${index}@offense-demo.example.com`),
  ),
];

describe('ISSUE-247 every handed-off database step goes through the gate', () => {
  test('with the gate at one step, no two handed-off database steps ever run at once', async () => {
    const harness = saturated();
    harness.db.user.push(existingAccount);
    const { steps } = harness;
    await Promise.all(
      requests().map((request) => harness.server.instance.handler(request)),
    );
    // Every answer is in, so only handed-off work makes steps from here.
    steps?.measure();
    await harness.server.settled();
    const started = steps?.started() ?? [];
    assert({
      given:
        'six saturated requests (three existing accounts, three unknown addresses) and a database gate of one',
      should:
        'run each lookup, suppression read, receipt write and token delete one at a time',
      actual: {
        peak: steps?.peak(),
        steps: {
          lookup: started.filter((name) => name === 'lookup').length,
          receipt: started.filter((name) => name === 'receipt write').length,
          delete: started.filter((name) => name === 'token delete').length,
        },
      },
      expected: {
        peak: 1,
        steps: { lookup: 6, receipt: 3, delete: 3 },
      },
    });
  });

  test('a held step keeps a second task’s database step waiting for it', async () => {
    const harness = saturated();
    const { steps } = harness;
    const lookups = () =>
      (steps?.started() ?? []).filter((name) => name === 'lookup').length;
    // The first task's lookup is held inside the gate of one.
    const release = steps?.holdNext('lookup') ?? (() => {});
    await harness.server.instance.handler(magicLinkRequest());
    await harness.server.instance.handler(
      magicLinkRequest({}, 'second@offense-demo.example.com'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const whileHeld = lookups();
    release();
    await harness.server.settled();
    assert({
      given:
        'a gate of one, the first handed-off task’s lookup held, and a second saturated request',
      should:
        'start no lookup for the second task until the first is released, then run both',
      actual: { whileHeld, after: lookups() },
      expected: { whileHeld: 1, after: 2 },
    });
  });
});
