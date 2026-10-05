import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createAppError, createInvariantError } from '@offense-demo/errors';
import { handleOperation, readJson } from './http';
import { createRecordingLogger } from './test-loggers.test-support';

setupRitewayBun();

const { recorded, logger } = createRecordingLogger();

const jsonRequest = (body: string, contentType = 'application/json') =>
  new Request('http://localhost/api/account/username', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

describe('handleOperation', () => {
  test('answers an oversized body with HTTP 413', async () => {
    const large = JSON.stringify({ text: 'x'.repeat(128) });
    const response = await handleOperation(
      logger,
      jsonRequest(large),
      'test.oversized',
      async () => Response.json(await readJson(jsonRequest(large), 64)),
    );
    assert({
      given: 'a body beyond the byte bound',
      should: 'answer 413 with the payload-too-large code',
      actual: {
        status: response.status,
        code: ((await response.json()) as { error: { code: string } }).error
          .code,
      },
      expected: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  test('returns handler responses with correlation headers and logs completion', async () => {
    recorded.length = 0;
    const response = await handleOperation(
      logger,
      new Request('http://localhost/api/account/username'),
      'test.operation',
      () => Promise.resolve(Response.json({ ok: true })),
    );
    assert({
      given: 'a successful operation',
      should: 'respond 200 with a correlation header',
      actual: {
        status: response.status,
        hasRequestId: Boolean(response.headers.get('x-request-id')),
      },
      expected: { status: 200, hasRequestId: true },
    });
    assert({
      given: 'a completed operation',
      should: 'log completion as an info-severity event',
      actual: recorded.at(-1)?.event,
      expected: 'http.request.completed',
    });
    assert({
      given: 'a request-scoped operation logger',
      should: 'bind request correlation and operation context',
      actual: (({ operation, requestId, traceId }) => ({
        operation,
        requestId,
        traceId,
      }))(recorded.at(-1)?.fields as Record<string, unknown>),
      expected: {
        operation: 'test.operation',
        requestId: response.headers.get('x-request-id'),
        traceId: undefined,
      },
    });
  });

  test('logs the ingress-stamped keyed client id hash, never the raw address', async () => {
    const keyed =
      '5630bc61fdecfeaed71c2c477912209c9c8626ca5dd485455024185bffa9d87b';
    const unkeyed =
      '6896eba5c88ed496934ccd4986c63e35dc5f89210f182d4dadd9b218a09337e1';
    recorded.length = 0;
    await handleOperation(
      logger,
      new Request('http://localhost/api/account/username', {
        headers: {
          'x-offense-demo-client-ip': '203.0.113.9',
          'x-offense-demo-client-id-hash': keyed,
        },
      }),
      'test.operation',
      () => Promise.resolve(Response.json({ ok: true })),
    );
    const serialized = JSON.stringify(recorded);
    assert({
      given:
        'a request carrying the ingress-stamped identity and its keyed hash',
      should:
        'log the keyed hash, never the raw address or its enumerable unkeyed SHA3-256',
      actual: {
        clientIdHash: (recorded.at(-1)?.fields as Record<string, unknown>)
          .clientIdHash,
        leaksRawAddress: serialized.includes('203.0.113.9'),
        logsUnkeyedHash: serialized.includes(unkeyed),
      },
      expected: {
        clientIdHash: keyed,
        leaksRawAddress: false,
        logsUnkeyedHash: false,
      },
    });

    recorded.length = 0;
    await handleOperation(
      logger,
      new Request('http://localhost/api/account/username', {
        headers: { 'x-offense-demo-client-ip': '203.0.113.9' },
      }),
      'test.operation',
      () => Promise.resolve(Response.json({ ok: true })),
    );
    assert({
      given: 'a request with an identity but no ingress-stamped hash',
      should: 'log no clientIdHash field rather than hash the address itself',
      actual: (recorded.at(-1)?.fields as Record<string, unknown>).clientIdHash,
      expected: undefined,
    });
  });

  test('honors caller request IDs that pass the format constraint', async () => {
    const response = await handleOperation(
      logger,
      new Request('http://localhost/api/account/username', {
        headers: { 'x-request-id': 'caller-provided-id-123' },
      }),
      'test.operation',
      () => Promise.resolve(new Response(null, { status: 204 })),
    );
    assert({
      given: 'a caller-provided request id',
      should: 'echo it on the response',
      actual: response.headers.get('x-request-id'),
      expected: 'caller-provided-id-123',
    });
  });

  test('maps domain invariants to stable public errors without leaking internals', async () => {
    const internalDetail = 'participant row 3481 violated archetype storage';
    const response = await handleOperation(
      logger,
      new Request('http://localhost/api/account/username'),
      'test.operation',
      () =>
        Promise.reject(
          createAppError('INVARIANT', `Secret detail: ${internalDetail}`),
        ),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };
    assert({
      given: 'a rejected domain invariant',
      should: 'respond 422',
      actual: response.status,
      expected: 422,
    });
    assert({
      given: 'a rejected domain invariant',
      should: 'emit the stable INVARIANT code',
      actual: body.error.code,
      expected: 'INVARIANT',
    });
    assert({
      given: 'a rejected domain invariant',
      should: 'use the stable public message',
      actual: body.error.message,
      expected: 'Domain operation is not allowed',
    });
    assert({
      given: 'a rejected domain invariant with internal details',
      should: 'never serialize the details',
      actual: JSON.stringify(body).includes(internalDetail),
      expected: false,
    });
    assert({
      given: 'a mapped public error',
      should: 'include a request id',
      actual: Boolean(body.error.requestId),
      expected: true,
    });
  });

  test('emits invariant telemetry with the stable invariant identity', async () => {
    recorded.length = 0;
    const invariantId = 'room.active.requires-members';
    await handleOperation(
      logger,
      new Request('http://localhost/api/account/username'),
      'test.operation',
      () => Promise.reject(createInvariantError(invariantId)),
    );
    const invariantEvent = recorded.find(
      ({ event }) => event === 'invariant.violated',
    );
    assert({
      given: 'a production invariant failure',
      should: 'emit an invariant violation event with its stable identity',
      actual: (invariantEvent?.fields as { invariantId?: string }).invariantId,
      expected: invariantId,
    });
  });

  test('maps unexpected failures to INTERNAL and never exposes causes', async () => {
    recorded.length = 0;
    const response = await handleOperation(
      logger,
      new Request('http://localhost/api/account/username'),
      'test.operation',
      () =>
        Promise.reject(
          new Error('ECONNREFUSED 10.0.0.12:5432 from connection pool'),
        ),
    );
    const body = (await response.json()) as { error: { code: string } };
    assert({
      given: 'an unexpected infrastructure failure',
      should: 'respond 500 with the INTERNAL code',
      actual: { status: response.status, code: body.error.code },
      expected: { status: 500, code: 'INTERNAL' },
    });
    assert({
      given: 'an unexpected infrastructure failure',
      should: 'never expose the cause',
      actual: JSON.stringify(body).includes('ECONNREFUSED'),
      expected: false,
    });
    assert({
      given: 'an unexpected infrastructure failure',
      should: 'emit the failed lifecycle event',
      actual: recorded.at(-1)?.event,
      expected: 'http.request.failed',
    });
    assert({
      given: 'an unexpected infrastructure failure mapped to a public status',
      should:
        'log the response status alongside the error code (AUTH-7.7 5xx-rate alert input)',
      actual: (recorded.at(-1)?.fields as { status?: number }).status,
      expected: response.status,
    });
  });

  test('cancelled requests log without error-level noise and return 499', async () => {
    recorded.length = 0;
    const controller = new AbortController();
    controller.abort();
    const response = await handleOperation(
      logger,
      new Request('http://localhost/api/account/username', {
        signal: controller.signal,
      }),
      'test.operation',
      () => Promise.resolve(Response.json({ ok: true })),
    );
    assert({
      given: 'an aborted request',
      should: 'respond 499',
      actual: response.status,
      expected: 499,
    });
    assert({
      given: 'an aborted request',
      should: 'log as a warn-severity event',
      actual: recorded.at(-1)?.event,
      expected: 'http.request.cancelled',
    });
    assert({
      given: 'an aborted request',
      should: 'include request-scoped operation context',
      actual: recorded.at(-1)?.fields,
      expected: {
        operation: 'test.operation',
        requestId: response.headers.get('x-request-id'),
        traceId: undefined,
        durationMs: (recorded.at(-1)?.fields as { durationMs: number })
          .durationMs,
        errorCode: 'REQUEST_CANCELLED',
      },
    });
  });
});
