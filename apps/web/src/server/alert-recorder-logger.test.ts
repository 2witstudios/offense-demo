import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { withAlertRecording } from './alert-recorder';

setupRitewayBun();

describe('withAlertRecording (AUTH-7.7)', () => {
  test('feeds every logged event, including from children, to the recorder', () => {
    const observed: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const logged: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const baseLogger = {
      log: (event: string, fields: Record<string, unknown>) =>
        void logged.push({ event, fields }),
      child(fields: Record<string, unknown>) {
        return {
          log: (event: string, childFields: Record<string, unknown>) =>
            void logged.push({ event, fields: { ...fields, ...childFields } }),
          child: () => this,
        };
      },
    };
    const wrapped = withAlertRecording(baseLogger, {
      observe: (event, fields) => observed.push({ event, fields }),
    });
    wrapped.log('auth.mail.failed', {}, 'msg');
    const child = wrapped.child({ requestId: 'r1' });
    child.log(
      'retention.sweep.completed',
      { operation: 'retention.session' },
      'msg',
    );
    assert({
      given: 'a top-level log and a child log',
      should: 'observe both and still forward both to the wrapped logger',
      actual: {
        observedEvents: observed.map((entry) => entry.event),
        loggedEvents: logged.map((entry) => entry.event),
      },
      expected: {
        observedEvents: ['auth.mail.failed', 'retention.sweep.completed'],
        loggedEvents: ['auth.mail.failed', 'retention.sweep.completed'],
      },
    });
  });

  test('observes fields a child bound, as handleOperation binds operation (ISSUE-173)', () => {
    const observed: Array<Record<string, unknown>> = [];
    const logger = {
      log: () => {},
      child: () => logger,
    };
    const wrapped = withAlertRecording(logger, {
      observe: (_event, fields) => void observed.push(fields),
    });
    wrapped
      .child({ requestId: 'r1', operation: 'auth.request' })
      .child({ traceId: 't1' })
      .log('http.request.completed', { status: 429, durationMs: 3 }, 'msg');
    assert({
      given:
        'an HTTP completion logged by a grandchild whose ancestors bound the request and operation',
      should: 'observe the bound fields merged under the call fields',
      actual: observed,
      expected: [
        {
          requestId: 'r1',
          operation: 'auth.request',
          traceId: 't1',
          status: 429,
          durationMs: 3,
        },
      ],
    });
  });

  test('feeds each recorder exactly once per event', () => {
    const counts = { alerts: 0, metrics: 0 };
    const logger = { log: () => {}, child: () => logger };
    const wrapped = withAlertRecording(
      logger,
      { observe: () => void (counts.alerts += 1) },
      { observe: () => void (counts.metrics += 1) },
    );
    wrapped
      .child({ operation: 'auth.request' })
      .log('http.request.completed', { status: 200 }, 'msg');
    assert({
      given: 'one logged event and two recorders',
      should: 'observe it once in each',
      actual: counts,
      expected: { alerts: 1, metrics: 1 },
    });
  });
});
