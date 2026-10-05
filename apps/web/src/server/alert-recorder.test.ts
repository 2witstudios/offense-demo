import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock } from '@offense-demo/clock';
import { createAlertRecorder, type AlertRecorderRedis } from './alert-recorder';

setupRitewayBun();

type Call = { readonly op: string; readonly args: readonly unknown[] };

function fakeAlertRedis() {
  const calls: Call[] = [];
  const redis: AlertRecorderRedis = {
    markOccurrenceSince: async (key, value, ttl) => {
      calls.push({ op: 'markOccurrenceSince', args: [key, value, ttl] });
      return value;
    },
    incrementWithExpiry: async (key, ttl) => {
      calls.push({ op: 'incrementWithExpiry', args: [key, ttl] });
      return 1;
    },
    delete: async (key) => {
      calls.push({ op: 'delete', args: [key] });
    },
    setEphemeral: async (key, value, ttl) => {
      calls.push({ op: 'setEphemeral', args: [key, value, ttl] });
    },
  };
  return { redis, calls };
}

const NOW = '2026-09-25T12:00:00.000Z';

describe('createAlertRecorder (AUTH-7.7)', () => {
  test('marks storage unavailable on auth.session.unavailable', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('auth.session.unavailable', { operation: 'x' });
    assert({
      given: 'a session storage unavailability event',
      should:
        'mark the storage occurrence, keeping since-time and re-arming the 3-minute bridging TTL',
      actual: calls,
      expected: [
        {
          op: 'markOccurrenceSince',
          args: ['alert-unavailable-storage', NOW, 180],
        },
      ],
    });
  });

  test('marks the limiter unavailable on auth.rate_limit.unavailable', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('auth.rate_limit.unavailable', {});
    assert({
      given: 'a rate-limiter unavailability event',
      should:
        'mark the limiter occurrence, keeping since-time and re-arming the 3-minute bridging TTL',
      actual: calls,
      expected: [
        {
          op: 'markOccurrenceSince',
          args: ['alert-unavailable-limiter', NOW, 180],
        },
      ],
    });
  });

  test('increments consecutive mail failures on auth.mail.failed, resets on auth.mail.sent', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('auth.mail.failed', {});
    recorder.observe('auth.mail.sent', {});
    assert({
      given: 'a delivery failure followed by a successful send',
      should: 'increment the bounded counter then delete it',
      actual: calls,
      expected: [
        {
          op: 'incrementWithExpiry',
          args: ['alert-mail-consecutive-failures', 3600],
        },
        { op: 'delete', args: ['alert-mail-consecutive-failures'] },
      ],
    });
  });

  test('records the last successful sweep on retention.sweep.completed', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('retention.sweep.completed', {
      operation: 'retention.session',
    });
    assert({
      given: 'a completed retention sweep',
      should: 'record the durable last-success marker',
      actual: calls,
      expected: [
        {
          op: 'setEphemeral',
          args: ['alert-retention-last-success', NOW, 2_592_000],
        },
      ],
    });
  });

  test('never records anything for retention.sweep.failed (lets it go stale)', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('retention.sweep.failed', {
      operation: 'retention.session',
    });
    assert({
      given: 'a failed retention sweep',
      should: 'touch nothing, so cleanup_missed can fire once stale enough',
      actual: calls,
      expected: [],
    });
  });

  test('counts auth-operation http completions into the current minute bucket, 5xx separately', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    const bucket = Math.floor(Date.parse(NOW) / 60_000);
    recorder.observe('http.request.completed', {
      operation: 'auth.request',
      status: 200,
    });
    recorder.observe('http.request.failed', {
      operation: 'auth.request',
      status: 503,
    });
    assert({
      given: 'a successful and a failed auth-operation request',
      should:
        'increment the total bucket for both and the 5xx bucket only for the failure',
      actual: calls,
      expected: [
        {
          op: 'incrementWithExpiry',
          args: [`alert-http-total-${bucket}`, 660],
        },
        {
          op: 'incrementWithExpiry',
          args: [`alert-http-total-${bucket}`, 660],
        },
        { op: 'incrementWithExpiry', args: [`alert-http-5xx-${bucket}`, 660] },
      ],
    });
  });

  test('counts shed work and network denials into their minute buckets, keyed by time only (ISSUE-220, AUTH-3.10)', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    const bucket = Math.floor(Date.parse(NOW) / 60_000);
    recorder.observe('auth.mail.shed', {
      operation: 'auth.after-response',
      pending: 68,
    });
    recorder.observe('auth.rate_limit.network_denied', { scope: 'ipv6_48' });
    recorder.observe('auth.rate_limit.network_denied', { scope: 'ipv4_24' });
    const increment = (key: string) => ({
      op: 'incrementWithExpiry',
      args: [`${key}-${bucket}`, 660],
    });
    assert({
      given:
        'one shed piece of work and two network denials of different scopes in one minute',
      should:
        'increment that minute’s shed bucket once and its network bucket twice, under the 11-minute bucket TTL, with no scope or network in the key',
      actual: calls,
      expected: [
        increment('alert-mail-shed'),
        increment('alert-network-denied'),
        increment('alert-network-denied'),
      ],
    });
  });

  test('ignores non-auth operations and completions without a numeric status', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('http.request.completed', {
      operation: 'health.readiness',
      status: 200,
    });
    recorder.observe('http.request.completed', { operation: 'auth.request' });
    assert({
      given: 'a non-auth operation and an auth operation with no status field',
      should:
        'record nothing for either (bounded cardinality: only auth.* counted)',
      actual: calls,
      expected: [],
    });
  });

  test('ignores events outside the observed set', () => {
    const { redis, calls } = fakeAlertRedis();
    const recorder = createAlertRecorder({ redis, clock: fixedClock(NOW) });
    recorder.observe('auth.magic_link.verified', { operation: 'auth.request' });
    assert({
      given: 'an event this recorder does not track',
      should: 'touch Redis for nothing',
      actual: calls,
      expected: [],
    });
  });
});
