import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createAppError, createInvariantError } from './index';
import { assertRejects, rejectionOf } from './testing';

setupRitewayBun();

describe('rejectionOf', () => {
  test('reads the code of a synchronous app error', async () => {
    assert({
      given: 'a thunk that throws a factory-minted app error',
      should: 'report its code',
      actual: await rejectionOf(() => {
        throw createAppError('VALIDATION');
      }),
      expected: { code: 'VALIDATION' },
    });
  });

  test('reads the code of a rejected promise', async () => {
    assert({
      given: 'a thunk that returns a rejected promise',
      should: 'report the rejection code',
      actual: await rejectionOf(() =>
        Promise.reject(createAppError('INFRASTRUCTURE')),
      ),
      expected: { code: 'INFRASTRUCTURE' },
    });
  });

  test('carries the invariant identity', async () => {
    assert({
      given: 'an invariant failure',
      should: 'report the invariant id beside the code',
      actual: await rejectionOf(() => {
        throw createInvariantError('room.membership.closed');
      }),
      expected: {
        code: 'INVARIANT',
        invariantId: 'room.membership.closed',
      },
    });
  });

  test('names a stray error instead of passing it', async () => {
    assert({
      given: 'a thunk that throws a plain TypeError',
      should: 'report it as not an app error',
      actual: await rejectionOf(() => {
        throw new TypeError('undefined is not a function');
      }),
      expected: { code: 'NOT_APP_ERROR', name: 'TypeError' },
    });
  });

  test('refuses a lookalike carrying a code property', async () => {
    assert({
      given: 'a driver error with a code property',
      should: 'report it as not an app error',
      actual: await rejectionOf(() => {
        throw Object.assign(new Error('refused'), { code: 'VALIDATION' });
      }),
      expected: { code: 'NOT_APP_ERROR', name: 'Error' },
    });
  });

  test('reports a thunk that settles normally', async () => {
    assert({
      given: 'a thunk that returns without throwing',
      should: 'report that nothing was rejected',
      actual: await rejectionOf(async () => 'fine'),
      expected: { code: 'NO_REJECTION' },
    });
  });
});

describe('assertRejects', () => {
  test('passes on the expected code', async () => {
    await assertRejects({
      given: 'an operation refused for authorization',
      should: 'reject with AUTHORIZATION',
      actual: () => Promise.reject(createAppError('AUTHORIZATION')),
      code: 'AUTHORIZATION',
    });
  });

  test('fails on a different code', async () => {
    await expect(
      assertRejects({
        given: 'an operation refused for validation',
        should: 'reject with AUTHORIZATION',
        actual: () => Promise.reject(createAppError('VALIDATION')),
        code: 'AUTHORIZATION',
      }),
    ).rejects.toThrow(
      'Given an operation refused for validation: should reject with AUTHORIZATION',
    );
  });

  test('fails on a stray error', async () => {
    await expect(
      assertRejects({
        given: 'a thunk with a bug in it',
        should: 'reject with VALIDATION',
        actual: () => {
          throw new TypeError('x is undefined');
        },
        code: 'VALIDATION',
      }),
    ).rejects.toThrow('NOT_APP_ERROR');
  });

  test('fails when nothing is rejected', async () => {
    await expect(
      assertRejects({
        given: 'an operation that succeeds',
        should: 'reject with CONFLICT',
        actual: () => undefined,
        code: 'CONFLICT',
      }),
    ).rejects.toThrow('NO_REJECTION');
  });

  test('checks the invariant id when one is expected', async () => {
    await expect(
      assertRejects({
        given: 'an invariant failure with another identity',
        should: 'reject with the named invariant',
        actual: () => {
          throw createInvariantError('room.capacity.full');
        },
        code: 'INVARIANT',
        invariantId: 'room.membership.closed',
      }),
    ).rejects.toThrow('room.membership.closed');
  });
});
