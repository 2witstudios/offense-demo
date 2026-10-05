import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { PasskeyAutofillOutcome } from '../sign-in-port';
import {
  AUTOFILL_REFRESH_MS,
  autofillRetryDelayMs,
  startPasskeyAutofill,
  type AutofillTimers,
} from './passkey-autofill';

setupRitewayBun();

/** Timers that only run when the test fires them. */
const fakeTimers = () => {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const timers: AutofillTimers = {
    set: (run, ms) => {
      next += 1;
      pending.set(next, { run, ms });
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    delays: () => [...pending.values()].map(({ ms }) => ms),
    fire: (ms: number) => {
      const entry = [...pending.entries()].find(([, timer]) => timer.ms === ms);
      if (!entry) throw new Error(`no timer pending for ${ms} ms`);
      pending.delete(entry[0]);
      entry[1].run();
    },
  };
};

/** Offers that stay pending until the test settles them, oldest first. */
const scriptedOffers = () => {
  const open: ((outcome: PasskeyAutofillOutcome) => void)[] = [];
  let started = 0;
  return {
    offer: () =>
      new Promise<PasskeyAutofillOutcome>((resolve) => {
        started += 1;
        open.push(resolve);
      }),
    started: () => started,
    settle: async (index: number, kind: PasskeyAutofillOutcome['kind']) => {
      open[index]?.({ kind });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
};

const run = () => {
  const scheduler = fakeTimers();
  const offers = scriptedOffers();
  const settled: string[] = [];
  let nowMs = 0;
  const stop = startPasskeyAutofill({
    offer: offers.offer,
    onSettled: (outcome) => settled.push(outcome.kind),
    timers: scheduler.timers,
    now: () => nowMs,
  });
  return {
    scheduler,
    offers,
    settled,
    stop,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

describe('autofillRetryDelayMs', () => {
  test('backs off exponentially up to the refresh interval', () => {
    assert({
      given: 'the first, second, third and a much later retry',
      should: 'wait 1 s, 2 s, 4 s, then no longer than the refresh interval',
      actual: [0, 1, 2, 20].map(autofillRetryDelayMs),
      expected: [1_000, 2_000, 4_000, AUTOFILL_REFRESH_MS],
    });
  });
});

describe('startPasskeyAutofill', () => {
  test('offers at once and refreshes before the challenge expires', async () => {
    const { scheduler, offers, settled } = run();
    const armed = [offers.started(), scheduler.delays()];
    scheduler.fire(AUTOFILL_REFRESH_MS);
    await offers.settle(0, 'superseded');
    assert({
      given: 'an armed email step left idle past the refresh interval',
      should:
        'offer once with a refresh pending, then offer again and ignore the replaced request',
      actual: { armed, started: offers.started(), settled },
      expected: {
        armed: [1, [AUTOFILL_REFRESH_MS]],
        started: 2,
        settled: [],
      },
    });
  });

  test('re-arms after a dismissal or a refused pick, backing off', async () => {
    const { scheduler, offers, settled } = run();
    await offers.settle(0, 'interrupted');
    const afterFirst = scheduler.delays();
    scheduler.fire(1_000);
    await offers.settle(1, 'refused');
    assert({
      given: 'a dismissed prompt, then a pick the server refused',
      should:
        'report both and wait 1 s, then 2 s, before offering again, with no refresh pending meanwhile',
      actual: {
        settled,
        afterFirst,
        afterSecond: scheduler.delays(),
        started: offers.started(),
      },
      expected: {
        settled: ['interrupted', 'refused'],
        afterFirst: [1_000],
        afterSecond: [2_000],
        started: 2,
      },
    });
  });

  test('re-arms after its own stale request supersedes it', async () => {
    const { scheduler, offers, settled } = run();
    await offers.settle(0, 'superseded');
    assert({
      given: 'a live request aborted by a stale one the loop no longer owns',
      should: 'report it and offer again after the first backoff step',
      actual: [settled, scheduler.delays()],
      expected: [['superseded'], [1_000]],
    });
  });

  test('stops for good when the browser cannot autofill', async () => {
    const { scheduler, offers, settled } = run();
    await offers.settle(0, 'unavailable');
    assert({
      given: 'a browser without conditional mediation',
      should: 'report it and schedule nothing further',
      actual: [settled, scheduler.delays()],
      expected: [['unavailable'], []],
    });
  });

  test('restarts the backoff after an ending a person caused', async () => {
    const { scheduler, offers, advance } = run();
    await offers.settle(0, 'interrupted');
    scheduler.fire(1_000);
    await offers.settle(1, 'interrupted');
    const quick = scheduler.delays();
    scheduler.fire(2_000);
    advance(30_000);
    await offers.settle(2, 'interrupted');
    assert({
      given:
        'two endings in quick succession, then one after the request sat pending for 30 s',
      should:
        'back off to 2 s for the quick one, then return to 1 s once a person clearly acted',
      actual: [quick, scheduler.delays()],
      expected: [[2_000], [1_000]],
    });
  });

  test('after stopping, drops stale endings but keeps what a pick produced', async () => {
    const dismissed = run();
    dismissed.stop();
    await dismissed.offers.settle(0, 'interrupted');
    const signedIn = run();
    signedIn.stop();
    await signedIn.offers.settle(0, 'signed-in');
    const refused = run();
    refused.stop();
    await refused.offers.settle(0, 'refused');
    assert({
      given:
        'stopped loops whose request later ends interrupted, signed in, or refused after a pick',
      should:
        'clear their timers, drop the interruption, and still report the sign-in and the refusal',
      actual: [
        [dismissed.settled, dismissed.scheduler.delays()],
        [signedIn.settled, signedIn.scheduler.delays()],
        [refused.settled, refused.scheduler.delays()],
      ],
      expected: [
        [[], []],
        [['signed-in'], []],
        [['refused'], []],
      ],
    });
  });

  test('stops once a live request signs in', async () => {
    const { scheduler, offers, settled } = run();
    await offers.settle(0, 'signed-in');
    assert({
      given: 'the live request signing the person in',
      should: 'report it and leave no refresh or retry pending',
      actual: [settled, scheduler.delays()],
      expected: [['signed-in'], []],
    });
  });
});
