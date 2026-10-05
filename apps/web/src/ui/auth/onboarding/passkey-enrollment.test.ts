import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createPasskeyEnrollment,
  enrollSafely,
  passkeyEnrollmentNotYetAvailable,
  type PasskeyEnrollmentClient,
} from './passkey-enrollment';

setupRitewayBun();

const clientWith = (
  error: { status?: number; code?: string } | null,
): PasskeyEnrollmentClient => ({
  passkey: { addPasskey: async () => ({ error }) },
});

describe('passkey enrollment seam', () => {
  test('the stage-4 seam never reports a save', async () => {
    assert({
      given: 'the seam before AUTH-5.x fills it',
      should: 'report unavailable, not saved',
      actual: await enrollSafely(passkeyEnrollmentNotYetAvailable),
      expected: { kind: 'unavailable' },
    });
  });

  test('a throwing seam is a failure', async () => {
    assert({
      given: 'a seam that throws before returning a promise',
      should: 'report failed',
      actual: await enrollSafely({
        enroll: () => {
          throw new Error('boom');
        },
      }),
      expected: { kind: 'failed' },
    });
  });
});

describe('createPasskeyEnrollment', () => {
  test('an unsupported browser never starts a ceremony', async () => {
    let called = false;
    const seam = createPasskeyEnrollment({
      client: {
        passkey: {
          addPasskey: async () => {
            called = true;
            return { error: null };
          },
        },
      },
      supportsPasskeys: () => false,
    });
    assert({
      given: 'a browser without WebAuthn support',
      should: 'report unavailable without calling the client',
      actual: { outcome: await seam.enroll(), called },
      expected: { outcome: { kind: 'unavailable' }, called: false },
    });
  });

  test('a ceremony that rejects asynchronously is a failure, never a stall (ISSUE-234)', async () => {
    const seam = createPasskeyEnrollment({
      client: {
        passkey: {
          addPasskey: () =>
            Promise.reject(new Error('The operation either timed out')),
        },
      },
      supportsPasskeys: () => true,
    });
    assert({
      given: 'a ceremony whose promise rejects after it has started',
      should: 'end in the failed outcome the page shows as a notice',
      actual: await enrollSafely(seam),
      expected: { kind: 'failed' },
    });
  });

  test('a successful ceremony reports saved', async () => {
    const seam = createPasskeyEnrollment({
      client: clientWith(null),
      supportsPasskeys: () => true,
    });
    assert({
      given: 'a client that resolves without an error',
      should: 'report saved',
      actual: await seam.enroll(),
      expected: { kind: 'saved' },
    });
  });

  test('a cancelled ceremony is distinguished from other failures', async () => {
    const seam = createPasskeyEnrollment({
      client: clientWith({ code: 'REGISTRATION_CANCELLED' }),
      supportsPasskeys: () => true,
    });
    assert({
      given: 'a client error naming a cancellation code',
      should: 'report cancelled, not failed',
      actual: await seam.enroll(),
      expected: { kind: 'cancelled' },
    });
  });

  test('any other client error reports failed', async () => {
    const seam = createPasskeyEnrollment({
      client: clientWith({ status: 500 }),
      supportsPasskeys: () => true,
    });
    assert({
      given: 'a client error with no cancellation code',
      should: 'report failed',
      actual: await seam.enroll(),
      expected: { kind: 'failed' },
    });
  });

  test('a stale session is distinguished from other failures', async () => {
    const byCode = createPasskeyEnrollment({
      client: clientWith({ code: 'SESSION_NOT_FRESH' }),
      supportsPasskeys: () => true,
    });
    const byStatus = createPasskeyEnrollment({
      client: clientWith({ status: 401 }),
      supportsPasskeys: () => true,
    });
    assert({
      given:
        'a fresh-session-gated registration rejected as SESSION_NOT_FRESH or 401',
      should: 'report stale-session, not the generic failed outcome',
      actual: {
        byCode: await byCode.enroll(),
        byStatus: await byStatus.enroll(),
      },
      expected: {
        byCode: { kind: 'stale-session' },
        byStatus: { kind: 'stale-session' },
      },
    });
  });
});
