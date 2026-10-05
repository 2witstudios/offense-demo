import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { errorSchema } from '@offense-demo/protocol';
import {
  createAppError,
  createInvariantError,
  isAppError,
  toPublicError,
} from './index';

setupRitewayBun();

describe('isAppError', () => {
  test('recognizes errors minted by the public factory', () => {
    assert({
      given: 'an error created through createAppError',
      should: 'be recognized as an app error',
      actual: isAppError(createAppError('NOT_FOUND')),
      expected: true,
    });
  });

  test('rejects lookalikes that merely carry a code property', () => {
    assert({
      given: 'a driver error with a code property',
      should: 'not be recognized as an app error',
      actual: isAppError(
        Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ERR_POSTGRES_CONNECTION_REFUSED',
        }),
      ),
      expected: false,
    });
    assert({
      given: 'a plain object claiming an error code',
      should: 'not be recognized as an app error',
      actual: isAppError({ code: 'VALIDATION' }),
      expected: false,
    });
    assert({
      given: 'a non-error value',
      should: 'not be recognized as an app error',
      actual: isAppError(undefined),
      expected: false,
    });
  });
});

describe('error mapping', () => {
  test('every public error body parses with the protocol errorSchema', () => {
    const codes = errorSchema.shape.code.options;
    assert({
      given: 'an error of every protocol code at a public boundary',
      should: 'produce an error body the protocol errorSchema accepts',
      actual: codes.map(
        (code) =>
          errorSchema.safeParse(
            toPublicError(createAppError(code), 'request-1').body.error,
          ).success,
      ),
      expected: codes.map(() => true),
    });
    assert({
      given: 'a registered invariant failure at a public boundary',
      should: 'produce an error body the protocol errorSchema accepts',
      actual: errorSchema.safeParse(
        toPublicError(createInvariantError('room.membership.closed'), 'r').body
          .error,
      ).success,
      expected: true,
    });
    assert({
      given: 'an unknown thrown value at a public boundary',
      should: 'publish an INTERNAL body the protocol errorSchema accepts',
      actual: errorSchema.parse(
        toPublicError(new Error('boom'), 'r').body.error,
      ).code,
      expected: 'INTERNAL',
    });
  });

  test('maps an oversized payload to HTTP 413 with a fixed public message', () => {
    assert({
      given: 'a payload-too-large error at a public boundary',
      should: 'map to a stable 413 body',
      actual: toPublicError(createAppError('PAYLOAD_TOO_LARGE'), 'request-1'),
      expected: {
        status: 413,
        body: {
          error: {
            version: 1,
            type: 'error',
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body too large',
            requestId: 'request-1',
          },
        },
      },
    });
  });

  test('preserves a stable invariant identity at the public boundary', () => {
    const error = createInvariantError('room.membership.requires-invitation');
    assert({
      given: 'a registered invariant failure',
      should: 'carry its stable invariant identity internally',
      actual: error.invariantId,
      expected: 'room.membership.requires-invitation',
    });
    assert({
      given: 'a registered invariant failure at a public boundary',
      should: 'include its stable invariant identity in the error body',
      actual: toPublicError(error, 'request-1').body.error.invariantId,
      expected: 'room.membership.requires-invitation',
    });
  });

  test('internal details and cause never cross the public boundary', () => {
    const cause = new Error('password=secret');
    const error = createAppError('INFRASTRUCTURE', 'postgres://secret', cause);
    assert({
      given: 'an infrastructure error created with a cause',
      should: 'retain the cause internally',
      actual: error.cause,
      expected: cause,
    });
    assert({
      given: 'an infrastructure error at a public boundary',
      should: 'map to a stable 503 body with a request id',
      actual: toPublicError(error, 'request-1'),
      expected: {
        status: 503,
        body: {
          error: {
            version: 1,
            type: 'error',
            code: 'INFRASTRUCTURE',
            message: 'Service temporarily unavailable',
            requestId: 'request-1',
          },
        },
      },
    });
    assert({
      given: 'an unexpected error carrying a secret',
      should: 'serialize without the secret',
      actual: JSON.stringify(toPublicError(cause, 'request-1')).includes(
        'secret',
      ),
      expected: false,
    });
    assert({
      given: 'a forged payload claiming a public code',
      should: 'map to INTERNAL status',
      actual: toPublicError({ code: 'VALIDATION', message: 'forged' }, 'r')
        .status,
      expected: 500,
    });
  });
});
