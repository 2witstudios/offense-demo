import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createLogger,
  type EventName,
  type Logger,
  type LogFields,
} from './index';

setupRitewayBun();

describe('structured logging', () => {
  test('derives the emitted level from the event registry', () => {
    let output = '';
    const logger = createLogger({
      service: 'test',
      destination: { write: (text) => (output += text) },
    });
    logger.log('request.unhandled', {}, 'failed');
    const entry = JSON.parse(output) as {
      event: string;
      level: number;
    };
    assert({
      given: 'an event with a registry-declared error severity',
      should: 'emit the event name and its registry severity',
      actual: { event: entry.event, level: entry.level },
      expected: { event: 'request.unhandled', level: 50 },
    });
  });

  test('exposes no caller-selected severity methods', () => {
    const logger = createLogger({ service: 'test' });
    // @ts-expect-error Severity methods are private to the logger implementation.
    type NoInfoMethod = Logger['info'];
    void (null as unknown as NoInfoMethod);
    assert({
      given: 'a constructed logger',
      should: 'expose only event-based emission',
      actual: Object.keys(logger).sort(),
      expected: ['child', 'log'],
    });
  });

  test('emits one canonical event field even when fields contain an event', () => {
    let output = '';
    const logger = createLogger({
      service: 'test',
      destination: { write: (text) => (output += text) },
    });
    logger.log(
      'server.start',
      { event: 'spoofed' } as unknown as LogFields,
      'started',
    );
    const entry = JSON.parse(output) as { event: string };
    assert({
      given: 'fields containing an untrusted event value',
      should: 'emit exactly one typed canonical event field',
      actual: {
        event: entry.event,
        occurrences: output.match(/"event"/g)?.length,
      },
      expected: { event: 'server.start', occurrences: 1 },
    });
  });

  test('logs structured context and redacts authentication fields', () => {
    let output = '';
    const logger = createLogger({
      service: 'test',
      destination: {
        write: (text) => {
          output += text;
        },
      },
    });
    logger.child({ requestId: 'request-1' }).log(
      'server.start',
      {
        authorization: 'secret',
        headers: { cookie: 'session' },
        durationMs: 12,
      },
      'completed',
    );
    const entry = JSON.parse(output) as {
      requestId: string;
      durationMs: number;
    };
    assert({
      given: 'a child logger with a request id',
      should: 'include the request id on emitted entries',
      actual: entry.requestId,
      expected: 'request-1',
    });
    assert({
      given: 'a log call with a duration field',
      should: 'keep structured numeric fields',
      actual: entry.durationMs,
      expected: 12,
    });
    assert({
      given: 'authorization and cookie values in log fields',
      should: 'redact them from the output',
      actual: output.includes('session') || output.includes('secret'),
      expected: false,
    });
  });

  // More redaction scenarios (secret-shaped field names at depth, err/cause,
  // a real Error's cause chain, URL-embedded tokens) live in redact.test.ts,
  // split out to keep this file under the line-count gate.

  test('rejects events outside the public vocabulary at compile time', () => {
    const logger = createLogger({ service: 'test' });
    // @ts-expect-error Event names are intentionally closed to known telemetry events.
    logger.log('not-a-telemetry-event', {}, 'invalid');
    const event: EventName = 'server.start';
    assert({
      given: 'a known telemetry event name',
      should: 'be accepted by the logger API',
      actual: event,
      expected: 'server.start',
    });
  });

  test('degrades an unknown runtime event to telemetry.unknown_event', () => {
    let output = '';
    const logger = createLogger({
      service: 'test',
      destination: { write: (text) => (output += text) },
    });
    logger.log(
      'not-a-telemetry-event' as EventName,
      {},
      'invalid runtime event',
    );
    const entry = JSON.parse(output) as { event: string };
    assert({
      given: 'an event supplied by an untyped runtime boundary',
      should: 'emit the stable unknown-event telemetry name',
      actual: entry.event,
      expected: 'telemetry.unknown_event',
    });
  });

  test('accepts adapter failure events in the public vocabulary', () => {
    const logger = createLogger({ service: 'test' });
    const events: EventName[] = ['db.query.failed', 'redis.command.failed'];
    for (const event of events) logger.log(event, {}, 'failed');

    assert({
      given: 'database and Redis adapter failure events',
      should: 'be accepted by the logger event vocabulary',
      actual: events,
      expected: ['db.query.failed', 'redis.command.failed'],
    });
  });

  test('accepts invariant violation events at error severity', () => {
    let output = '';
    const logger = createLogger({
      service: 'test',
      destination: { write: (text) => (output += text) },
    });
    logger.log(
      'invariant.violated',
      { invariantId: 'room.membership.requires-invitation' },
      'invariant violated',
    );
    const entry = JSON.parse(output) as { event: string; level: number };

    assert({
      given: 'a production invariant violation event',
      should: 'emit the stable event at error severity',
      actual: { event: entry.event, level: entry.level },
      expected: { event: 'invariant.violated', level: 50 },
    });
  });

  test('declares auth events with severities that match their meaning', () => {
    let output = '';
    const logger = createLogger({
      service: 'test',
      destination: { write: (text) => (output += text) },
    });
    const events: EventName[] = [
      'auth.rate_limit.denied',
      'auth.rate_limit.unavailable',
      'auth.session.unavailable',
      'auth.mail.sent',
      'auth.mail.failed',
      'auth.mail.receipt_failed',
      'auth.mail.suppressed',
      'auth.mail.shed',
      'auth.mail.abandoned',
      'retention.sweep.completed',
      'retention.sweep.failed',
    ];
    for (const event of events) logger.log(event, {}, 'auth');
    const entries = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string; level: number })
      .map(({ event, level }) => [event, level]);

    assert({
      given: 'rate-limit, session-store, mail delivery and retention events',
      should: 'log an expected denial as a warning and outages as errors',
      actual: entries,
      expected: [
        ['auth.rate_limit.denied', 40],
        ['auth.rate_limit.unavailable', 50],
        ['auth.session.unavailable', 50],
        ['auth.mail.sent', 30],
        ['auth.mail.failed', 50],
        ['auth.mail.receipt_failed', 50],
        ['auth.mail.suppressed', 30],
        ['auth.mail.shed', 40],
        ['auth.mail.abandoned', 50],
        ['retention.sweep.completed', 30],
        ['retention.sweep.failed', 50],
      ],
    });
  });
});
