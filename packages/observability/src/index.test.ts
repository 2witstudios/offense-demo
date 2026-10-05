import { expect } from 'bun:test';
import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createDrainState,
  currentTraceId,
  drainWithDeadline,
  extractTraceContext,
  installShutdownSignals,
  isValidTraceparent,
  requestId,
  withSpan,
  withTimeout,
} from './index';

setupRitewayBun();

describe('correlation', () => {
  test('accepts constrained identifiers only', () => {
    assert({
      given: 'a well-formed request id',
      should: 'pass it through unchanged',
      actual: requestId('request-123'),
      expected: 'request-123',
    });
    assert({
      given: 'a request id containing a newline',
      should: 'strip the control character',
      actual: requestId('bad\nheader').includes('\n'),
      expected: false,
    });
  });

  test('accepts only valid W3C traceparent values', () => {
    assert({
      given: 'a W3C traceparent from trusted ingress',
      should: 'accept the trace context format',
      actual: isValidTraceparent(
        '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      ),
      expected: true,
    });
    assert({
      given: 'a traceparent with an all-zero trace id',
      should: 'reject the trace context format',
      actual: isValidTraceparent(
        '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      ),
      expected: false,
    });
    assert({
      given: 'a malformed traceparent header',
      should: 'reject the trace context format',
      actual: isValidTraceparent('not-a-traceparent'),
      expected: false,
    });
  });

  test('has no trace id outside an active span', () => {
    assert({
      given: 'no active span',
      should: 'report no trace id',
      actual: currentTraceId(),
      expected: undefined,
    });
  });
});

describe('tracing', () => {
  test('extracts a valid ingress traceparent for the host provider through the propagation getter', () => {
    let readKeys: string[] = [];
    propagation.setGlobalPropagator({
      extract: (activeContext, carrier, carrierGetter) => {
        readKeys = carrierGetter.keys(carrier);
        const value = carrierGetter.get(carrier, 'traceparent');
        return typeof value === 'string'
          ? trace.setSpanContext(activeContext, {
              traceId: value.split('-')[1] ?? '',
              spanId: value.split('-')[2] ?? '',
              traceFlags: Number.parseInt(value.split('-')[3] ?? '0', 16),
              isRemote: true,
            })
          : activeContext;
      },
      inject: () => undefined,
      fields: () => ['traceparent'],
    });
    const extracted = extractTraceContext(
      new Headers({
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      }),
    );

    assert({
      given: 'a valid ingress traceparent and a carrier-reading propagator',
      should: 'hand the getter the ingress keys and expose the trace id',
      actual: {
        keys: readKeys,
        traceId: trace.getSpanContext(extracted)?.traceId,
      },
      expected: {
        keys: ['traceparent', 'tracestate'],
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      },
    });
    assert({
      given: 'a malformed traceparent',
      should: 'provide no remote span context',
      actual: trace.getSpanContext(
        extractTraceContext(new Headers({ traceparent: 'malformed' })),
      ),
      expected: trace.getSpanContext(ROOT_CONTEXT),
    });
  });

  test('preserves results and errors without a provider', async () => {
    assert({
      given: 'a span around a successful operation',
      should: 'return the operation result',
      actual: await withSpan('test', {}, async () => 42),
      expected: 42,
    });
    await expect(
      withSpan('test', {}, async () => {
        throw new Error('failure');
      }),
    ).rejects.toThrow('failure');
  });
});

describe('withTimeout', () => {
  test('bounds the wait', async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toThrow(
      'timed out',
    );
  });
});

describe('drainWithDeadline', () => {
  test('resolves once close finishes, never firing the deadline', async () => {
    let deadlineFired = false;
    await drainWithDeadline({
      deadlineMs: 50,
      onDeadlineExceeded: () => {
        deadlineFired = true;
      },
      close: async () => {},
    });

    assert({
      given: 'a close that finishes well within the deadline',
      should: 'resolve without firing onDeadlineExceeded',
      actual: deadlineFired,
      expected: false,
    });
  });

  test('fires onDeadlineExceeded when close outlasts the deadline', async () => {
    // The close settles only once the deadline has fired: a drain that
    // never fires it leaves the close pending and the test fails.
    let deadlineFired = false;
    let finishClose = () => {};
    await drainWithDeadline({
      deadlineMs: 5,
      onDeadlineExceeded: () => {
        deadlineFired = true;
        finishClose();
      },
      close: () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    });

    assert({
      given: 'a close slower than the deadline',
      should: 'fire onDeadlineExceeded before close resolves',
      actual: deadlineFired,
      expected: true,
    });
  });
});

describe('installShutdownSignals', () => {
  test('registers shutdown once for SIGTERM and SIGINT', () => {
    const registered: string[] = [];
    const target = {
      once: (signal: string) => {
        registered.push(signal);
      },
    };

    installShutdownSignals(async () => {}, target as never);

    assert({
      given: 'a shutdown callback and an injected process-like target',
      should: 'register it once for SIGTERM and SIGINT',
      actual: registered,
      expected: ['SIGTERM', 'SIGINT'],
    });
  });

  test('invoking a registered signal runs the shutdown callback', async () => {
    let ran = false;
    const handlers: Record<string, () => void> = {};
    const target = {
      once: (signal: string, handler: () => void) => {
        handlers[signal] = handler;
      },
    };

    installShutdownSignals(async () => {
      ran = true;
    }, target as never);
    handlers.SIGTERM?.();
    await Promise.resolve();

    assert({
      given: 'the registered SIGTERM handler firing',
      should: 'run the shutdown callback',
      actual: ran,
      expected: true,
    });
  });
});

describe('createDrainState', () => {
  test('drain flips readiness without closing anything', async () => {
    let closed = 0;
    const state = createDrainState([{ close: async () => void (closed += 1) }]);
    const before = state.isDraining();
    state.drain();
    assert({
      given: 'a running process told to drain',
      should: 'report draining from then on and close nothing',
      actual: { before, after: state.isDraining(), closed },
      expected: { before: false, after: true, closed: 0 },
    });
  });

  test('close drains and closes every closer once, even when one fails', async () => {
    const calls: string[] = [];
    const state = createDrainState([
      {
        close: async () => {
          calls.push('database');
          throw new Error('pool already closed');
        },
      },
      { close: () => void calls.push('redis') },
    ]);
    await state.close();
    assert({
      given: 'two closers, the first rejecting and the second synchronous',
      should: 'drain, call both exactly once and never reject',
      actual: { draining: state.isDraining(), calls },
      expected: { draining: true, calls: ['database', 'redis'] },
    });
  });
});
