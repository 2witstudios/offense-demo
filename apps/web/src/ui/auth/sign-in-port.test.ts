import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  offerPasskeyAutofillSafely,
  signInWithPasskeySafely,
  type SignInPort,
} from './sign-in-port';

setupRitewayBun();

const throwingPort: SignInPort = {
  signInWithPasskey: () => Promise.reject(new Error('ceremony blew up')),
  offerPasskeyAutofill: () => Promise.reject(new Error('autofill blew up')),
};

// Throws before any promise exists: client init or argument validation.
const synchronouslyThrowingPort: SignInPort = {
  signInWithPasskey: () => {
    throw new Error('WebAuthn options invalid');
  },
  offerPasskeyAutofill: () => {
    throw new Error('WebAuthn options invalid');
  },
};

const passingPort: SignInPort = {
  signInWithPasskey: () => Promise.resolve({ kind: 'signed-in' }),
  offerPasskeyAutofill: () => Promise.resolve({ kind: 'signed-in' }),
};

describe('signInWithPasskeySafely', () => {
  test('passes the outcome through', async () => {
    assert({
      given: 'a ceremony that succeeds',
      should: 'return signed-in',
      actual: await signInWithPasskeySafely(passingPort),
      expected: { kind: 'signed-in' },
    });
  });

  test('turns a throw into a failure, never a success', async () => {
    assert({
      given: 'a ceremony that throws',
      should: 'report a failure',
      actual: await signInWithPasskeySafely(throwingPort),
      expected: { kind: 'failed' },
    });
  });

  test('turns a synchronous throw into a failure', async () => {
    assert({
      given: 'a ceremony that throws before returning a promise',
      should: 'still settle as a failure instead of escaping',
      actual: await signInWithPasskeySafely(synchronouslyThrowingPort),
      expected: { kind: 'failed' },
    });
  });
});

describe('offerPasskeyAutofillSafely', () => {
  test('passes the outcome through', async () => {
    assert({
      given: 'an autofilled passkey the server verified',
      should: 'return signed-in',
      actual: await offerPasskeyAutofillSafely(passingPort),
      expected: { kind: 'signed-in' },
    });
  });

  test('turns an asynchronous or synchronous throw into an interruption', async () => {
    assert({
      given:
        'autofill requests that throw after and before returning a promise',
      should:
        'settle both as interrupted so autofill backs off and retries instead of going dead',
      actual: [
        await offerPasskeyAutofillSafely(throwingPort),
        await offerPasskeyAutofillSafely(synchronouslyThrowingPort),
      ],
      expected: [{ kind: 'interrupted' }, { kind: 'interrupted' }],
    });
  });
});
