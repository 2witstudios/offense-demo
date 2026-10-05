import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  initialSignInState,
  RESEND_COOLDOWN_MS,
  signInReducer,
} from './sign-in-state';
import { entering, inbox, iso } from './sign-in-state.test-support';

setupRitewayBun();

describe('initialSignInState', () => {
  test('starts on the email step', () => {
    assert({
      given: 'no email',
      should: 'start on an empty, idle email step',
      actual: initialSignInState(),
      expected: { step: 'enter-email', email: '', pending: 'none' },
    });
  });
});

describe('signInReducer: typing', () => {
  test('records the email and clears a notice', () => {
    assert({
      given: 'an undeliverable notice and a newly typed address',
      should: 'keep the new address and drop the stale notice',
      actual: signInReducer(entering({ notice: 'undeliverable' }), {
        type: 'email-typed',
        email: 'j@school.edu',
      }),
      expected: entering({ email: 'j@school.edu' }),
    });
  });

  test('ignores typing while a request is pending', () => {
    const state = entering({ pending: 'link' });
    assert({
      given: 'a pending link request',
      should: 'leave the state unchanged',
      actual: signInReducer(state, { type: 'email-typed', email: 'x' }),
      expected: state,
    });
  });
});

describe('signInReducer: magic link', () => {
  test('marks a link request pending with the trimmed email', () => {
    assert({
      given: 'an address with surrounding spaces',
      should: 'trim it and mark the link request pending',
      actual: signInReducer(entering({ email: '  jordan@lincoln.edu ' }), {
        type: 'link-requested',
      }),
      expected: entering({ pending: 'link' }),
    });
  });

  test('rejects a request without an email', () => {
    const state = entering({ email: '   ' });
    assert({
      given: 'a blank address',
      should: 'leave the state unchanged',
      actual: signInReducer(state, { type: 'link-requested' }),
      expected: state,
    });
  });

  test('moves to the inbox step when the link is sent', () => {
    assert({
      given: 'a pending request that was sent at 5000',
      should: 'show the inbox step, stamped with the send time',
      actual: signInReducer(entering({ pending: 'link' }), {
        type: 'link-settled',
        outcome: { kind: 'sent' },
        at: iso(5_000),
      }),
      expected: inbox({ sentAt: iso(5_000) }),
    });
  });

  test('returns to the email step with a notice on failure', () => {
    assert({
      given: 'a pending request the server refused as undeliverable',
      should: 'stay on the email step with the undeliverable notice',
      actual: signInReducer(entering({ pending: 'link' }), {
        type: 'link-settled',
        outcome: { kind: 'undeliverable' },
        at: iso(5_000),
      }),
      expected: entering({ notice: 'undeliverable' }),
    });
  });

  test('ignores a settlement nobody asked for', () => {
    const state = entering();
    assert({
      given: 'no pending request',
      should: 'leave the state unchanged',
      actual: signInReducer(state, {
        type: 'link-settled',
        outcome: { kind: 'sent' },
        at: iso(5_000),
      }),
      expected: state,
    });
  });
});

describe('signInReducer: passkey', () => {
  test('marks a passkey ceremony pending', () => {
    assert({
      given: 'an idle email step with a notice',
      should: 'start the ceremony and clear the notice',
      actual: signInReducer(entering({ notice: 'rate-limited' }), {
        type: 'passkey-requested',
      }),
      expected: entering({ pending: 'passkey' }),
    });
  });

  test('signs in on success', () => {
    assert({
      given: 'a pending ceremony that succeeded',
      should: 'reach the signed-in step',
      actual: signInReducer(entering({ pending: 'passkey' }), {
        type: 'passkey-settled',
        outcome: { kind: 'signed-in' },
      }),
      expected: { step: 'signed-in' },
    });
  });

  test('keeps the email path open when the ceremony is cancelled', () => {
    assert({
      given: 'a pending ceremony the person cancelled',
      should: 'stay on the email step with a cancellation notice',
      actual: signInReducer(entering({ pending: 'passkey' }), {
        type: 'passkey-settled',
        outcome: { kind: 'cancelled' },
      }),
      expected: entering({ notice: 'passkey-cancelled' }),
    });
  });

  test('ignores a passkey request while a link is pending', () => {
    const state = entering({ pending: 'link' });
    assert({
      given: 'a pending link request',
      should: 'leave the state unchanged',
      actual: signInReducer(state, { type: 'passkey-requested' }),
      expected: state,
    });
  });
});

describe('signInReducer: inbox', () => {
  test('goes back to the email step, keeping the address', () => {
    assert({
      given: 'the inbox step',
      should: 'return to an idle email step with the same address',
      actual: signInReducer(inbox(), { type: 'change-email' }),
      expected: entering(),
    });
  });

  test('refuses a resend during the cooldown', () => {
    const state = inbox();
    assert({
      given: 'a resend one second after sending',
      should: 'leave the state unchanged',
      actual: signInReducer(state, {
        type: 'resend-requested',
        at: iso(2_000),
      }),
      expected: state,
    });
  });

  test('resends once the cooldown has passed', () => {
    assert({
      given: 'a resend after the cooldown',
      should: 'mark the resend in flight',
      actual: signInReducer(inbox(), {
        type: 'resend-requested',
        at: iso(1_000 + RESEND_COOLDOWN_MS),
      }),
      expected: inbox({ resending: true }),
    });
  });

  test('restarts the cooldown when the resend is sent', () => {
    assert({
      given: 'a resend that was sent at 90000',
      should: 'stay on the inbox step with the new send time',
      actual: signInReducer(inbox({ resending: true }), {
        type: 'link-settled',
        outcome: { kind: 'sent' },
        at: iso(90_000),
      }),
      expected: inbox({ sentAt: iso(90_000) }),
    });
  });

  test('returns to the email step when a resend fails', () => {
    assert({
      given: 'a resend that was rate limited',
      should: 'show the email step with the rate-limit notice',
      actual: signInReducer(inbox({ resending: true }), {
        type: 'link-settled',
        outcome: { kind: 'rate-limited' },
        at: iso(90_000),
      }),
      expected: entering({ notice: 'rate-limited' }),
    });
  });
});
