import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock } from '@offense-demo/clock';
import { createAlertRecorder, type AlertRecorderRedis } from './alert-recorder';

setupRitewayBun();

/** Every command rejects, as with the Redis connection gone. */
const downAlertRedis = (): AlertRecorderRedis => {
  const down = async (): Promise<never> => {
    throw new Error('redis down');
  };
  return {
    markOccurrenceSince: down,
    incrementWithExpiry: down,
    delete: down,
    setEphemeral: down,
  };
};

const NOW = '2026-09-25T12:00:00.000Z';

/** A clock the test moves forward by hand. */
const steppedClock = (startIso: string) => {
  let nowMs = Date.parse(startIso);
  return {
    clock: { now: () => new Date(nowMs).toISOString() },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

describe('createAlertRecorder with its Redis down', () => {
  test('a Redis failure is swallowed, never thrown back at the caller', () => {
    const redis = downAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    let threw = false;
    try {
      recorder.observe('auth.session.unavailable', {});
    } catch {
      threw = true;
    }
    assert({
      given: 'a Redis command that rejects',
      should: 'never throw synchronously back at the logger call site',
      actual: threw,
      expected: false,
    });
  });

  test('keeps when the limiter became unavailable in process while its Redis is down (ISSUE-191)', () => {
    const { clock, advance } = steppedClock(NOW);
    const recorder = createAlertRecorder({ redis: downAlertRedis(), clock });
    const before = recorder.limiterUnavailableSince();
    recorder.observe('auth.rate_limit.unavailable', {});
    advance(60_000);
    recorder.observe('auth.rate_limit.unavailable', {});
    advance(61_000);
    recorder.observe('auth.rate_limit.unavailable', {});
    assert({
      given:
        'limiter unavailability observed three times over 2 minutes 1 second, each Redis write rejected',
      should: 'report none before, then the first occurrence as the since-time',
      actual: { before, since: recorder.limiterUnavailableSince() },
      expected: { before: null, since: NOW },
    });
  });

  test('a quiet gap longer than the 3-minute bridge ends the in-process limiter outage (ISSUE-191)', () => {
    const { clock, advance } = steppedClock(NOW);
    const recorder = createAlertRecorder({ redis: downAlertRedis(), clock });
    recorder.observe('auth.rate_limit.unavailable', {});
    advance(180_000);
    const atBridge = recorder.limiterUnavailableSince();
    advance(1);
    const afterBridge = recorder.limiterUnavailableSince();
    recorder.observe('auth.rate_limit.unavailable', {});
    assert({
      given:
        'one limiter unavailability, then 3 minutes and then 1 ms more of quiet, then another',
      should:
        'hold the since-time through the bridge, drop it after, and start a new outage at the next occurrence',
      actual: {
        atBridge,
        afterBridge,
        next: recorder.limiterUnavailableSince(),
      },
      expected: {
        atBridge: NOW,
        afterBridge: null,
        next: clock.now(),
      },
    });
  });
});
