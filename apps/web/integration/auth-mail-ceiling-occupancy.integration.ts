import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { saturateGlobalMinute } from './auth-ceiling-helpers';
import { createAccountFlows } from './auth-account-helpers';
import { elapse, recipientBucket } from './auth-rate-limit-helpers';
import { createTestApp, type TestApp } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';

/**
 * The residual ADR 0025 records against DEC-41 (ISSUE-185, DEC-76): a real
 * send holds its handed-off slot for a provider round trip, and a dropped
 * sign-up frees its slot in milliseconds. That difference can be seen only
 * through shedding, and shedding happens only once the whole occupancy
 * pool is full. So a canary request right behind a target is mailed
 * whatever the target while the pool has room, and is shed behind an
 * existing target but mailed behind an unknown one once it is full.
 *
 * The full pool is one slot wide here (`afterResponseLimits`), so the
 * target's own work fills it; in production it takes a flood holding all
 * AFTER_RESPONSE_MAX_RUNNING slots (ADR 0025 gives the rate).
 *
 * No step waits on elapsed time (ISSUE-280). The provider round trip is a
 * latch the test holds until the canary is decided: a real send holds its
 * slot for exactly that long however loaded the machine is, and a dropped
 * sign-up has released its slot before the canary is sent. The admit-or-shed
 * decision is made before the canary's answer returns, so releasing the
 * latch afterwards cannot change it. With a wall-clock round trip instead,
 * a canary request slower than the round trip found the slot already free
 * and was mailed (existing: 1, seen at a load average of 300).
 */
requireTestServices(process.env);
setupRitewayBun();

const TRIALS = 10;

/** The canary attack against one app: how many canaries were mailed. */
const canaryAttack = (testApp: TestApp) => {
  const accounts = createAccountFlows(testApp);
  const magicLink = (email: string) =>
    accounts.flows.authRoute.POST(
      accounts.flows.jsonPost(
        '/api/auth/sign-in/magic-link',
        { email },
        { [CLIENT_IP_HEADER]: testApp.newClient() },
      ),
    );
  const room = (email: string) =>
    elapse(
      testApp,
      ...[60, 3_600, 86_400].map((window) =>
        recipientBucket(testApp, 'magic-link', email, window),
      ),
    );
  const settled = () => testApp.app.auth().settled();
  return async () => {
    const target = (await accounts.signUp()).email;
    const canary = (await accounts.signUp()).email;
    await saturateGlobalMinute({
      testApp,
      magicLink,
      fresh: testApp.freshEmail,
      settled,
    });
    const trial = async (targetEmail: string, exists: boolean) => {
      await room(targetEmail);
      await room(canary);
      const from = testApp.mailbox.mails.length;
      const release = testApp.mailbox.hold();
      try {
        const arrival = testApp.mailbox.nextArrival();
        await magicLink(targetEmail);
        // A real send is in flight at the provider and holds its slot until
        // the release below; a dropped sign-up never reaches the provider,
        // so its slot is free once its work has settled.
        await (exists ? arrival : settled());
        await magicLink(canary);
      } finally {
        release();
      }
      await settled();
      return testApp.mailbox.mails.slice(from).some(({ to }) => to === canary)
        ? 1
        : 0;
    };
    let existing = 0;
    let unknown = 0;
    for (let index = 0; index < TRIALS; index += 1) {
      existing += await trial(target, true);
      unknown += await trial(testApp.freshEmail(), false);
    }
    return { existing, unknown };
  };
};

const withRoom = canaryAttack(createTestApp());
const full = canaryAttack(
  createTestApp({}, { maxRunning: 1, maxQueued: 0, dbSteps: 4 }),
);

describe('ISSUE-185 residual: slot occupancy shows account existence only once the pool is full (DEC-76)', () => {
  test('while the occupancy pool has room, a canary is mailed behind any target', async () => {
    assert({
      given: `a saturated ceiling, a provider held until the canary is decided, the production occupancy pool, and a canary right behind each of ${TRIALS} existing and ${TRIALS} unknown targets`,
      should: 'mail every canary, whatever the target',
      actual: await withRoom(),
      expected: { existing: TRIALS, unknown: TRIALS },
    });
  }, 300_000);

  test('once the occupancy pool is full, a canary is shed behind an existing target and mailed behind an unknown one', async () => {
    assert({
      given:
        'the same attack with the pool one slot wide, so the target’s own work fills it',
      should:
        'shed every canary behind a real send, which holds the slot for the round trip, and mail every canary behind a dropped sign-up, which frees it at once',
      actual: await full(),
      expected: { existing: 0, unknown: TRIALS },
    });
  }, 300_000);
});
