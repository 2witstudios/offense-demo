import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createBetterAuthSignInPort,
  type SignInClient,
} from './better-auth-sign-in-port';

setupRitewayBun();

type Error = { status?: number; code?: string } | null;

const portWith = ({
  passkey = null,
  supported = true,
  autofill = true,
}: {
  passkey?: Error;
  supported?: boolean;
  autofill?: boolean;
}) => {
  const calls: unknown[] = [];
  const client: SignInClient = {
    signIn: {
      passkey: async (opts) => {
        calls.push(opts?.autoFill ? 'passkey-autofill' : 'passkey');
        return { error: passkey };
      },
    },
  };
  return {
    calls,
    port: createBetterAuthSignInPort({
      client,
      supportsPasskeys: () => supported,
      supportsPasskeyAutofill: async () => autofill,
    }),
  };
};

describe('Better Auth sign-in port: passkey', () => {
  test('a verified ceremony signs in', async () => {
    assert({
      given: 'a ceremony the server verified',
      should: 'report signed-in',
      actual: await portWith({}).port.signInWithPasskey(),
      expected: { kind: 'signed-in' },
    });
  });

  test('a dismissed prompt is cancelled and never a success', async () => {
    const outcome = async (passkey: Error) =>
      (await portWith({ passkey }).port.signInWithPasskey()).kind;
    assert({
      given: 'cancelled, aborted, server-refused and unknown ceremonies',
      should: 'answer cancelled, cancelled, failed, failed',
      actual: [
        await outcome({ status: 400, code: 'AUTH_CANCELLED' }),
        await outcome({ status: 400, code: 'ERROR_CEREMONY_ABORTED' }),
        await outcome({ status: 401, code: 'AUTHENTICATION_FAILED' }),
        await outcome({}),
      ],
      expected: ['cancelled', 'cancelled', 'failed', 'failed'],
    });
  });

  test('a browser without WebAuthn is unsupported and starts no ceremony', async () => {
    const { port, calls } = portWith({ supported: false });
    assert({
      given: 'a browser that cannot do WebAuthn',
      should: 'report unsupported without calling the client',
      actual: [await port.signInWithPasskey(), calls],
      expected: [{ kind: 'unsupported' }, []],
    });
  });
});

describe('Better Auth sign-in port: passkey autofill', () => {
  test('arms browser autofill and signs in when a passkey is picked', async () => {
    const { port, calls } = portWith({});
    assert({
      given: 'a browser with conditional mediation and a verified pick',
      should: 'start an autofill ceremony and report signed-in',
      actual: [await port.offerPasskeyAutofill(), calls],
      expected: [{ kind: 'signed-in' }, ['passkey-autofill']],
    });
  });

  test('refuses only after a pick reached verification', async () => {
    const outcome = async (error: Error, picked: boolean) => {
      const client: SignInClient = {
        signIn: {
          passkey: async (opts) => {
            // Better Auth hands `fetchOptions` only to the verify request.
            if (picked) opts?.fetchOptions?.onRequest?.();
            return { error };
          },
        },
      };
      const port = createBetterAuthSignInPort({
        client,
        supportsPasskeys: () => true,
        supportsPasskeyAutofill: async () => true,
      });
      return (await port.offerPasskeyAutofill()).kind;
    };
    assert({
      given:
        'an abort, a failed options fetch, a dismissed prompt, a lost challenge after a pick, and a verify outage after a pick',
      should: 'answer superseded, interrupted, interrupted, refused, refused',
      actual: [
        await outcome({ status: 400, code: 'ERROR_CEREMONY_ABORTED' }, false),
        await outcome({ status: 403 }, false),
        await outcome(
          { status: 400, code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' },
          false,
        ),
        await outcome({ status: 400, code: 'CHALLENGE_NOT_FOUND' }, true),
        await outcome({ status: 400, code: 'AUTH_CANCELLED' }, true),
      ],
      expected: [
        'superseded',
        'interrupted',
        'interrupted',
        'refused',
        'refused',
      ],
    });
  });

  test('a browser without conditional mediation starts no ceremony', async () => {
    const { port, calls } = portWith({ autofill: false });
    assert({
      given: 'a browser that cannot offer passkeys in autofill',
      should: 'report unavailable without calling the client',
      actual: [await port.offerPasskeyAutofill(), calls],
      expected: [{ kind: 'unavailable' }, []],
    });
  });
});

/**
 * A client whose autofill ceremony stays pending until released, and whose
 * button ceremonies answer from a script, for the abort race.
 */
const racingPort = (button: readonly Error[]) => {
  const calls: string[] = [];
  let releaseAutofill: (error: Error) => void = () => {};
  const script = [...button];
  const client: SignInClient = {
    signIn: {
      passkey: (opts) => {
        if (opts?.autoFill) {
          calls.push('passkey-autofill');
          return new Promise((resolve) => {
            releaseAutofill = (error) => resolve({ error });
          });
        }
        calls.push('passkey');
        return Promise.resolve({ error: script.shift() ?? null });
      },
    },
  };
  const port = createBetterAuthSignInPort({
    client,
    supportsPasskeys: () => true,
    supportsPasskeyAutofill: async () => true,
  });
  return {
    port,
    calls,
    releaseAutofill: (error: Error) => releaseAutofill(error),
  };
};

describe('Better Auth sign-in port: autofill and button race', () => {
  test('retries the button once when a late autofill request aborted it', async () => {
    const { port, calls, releaseAutofill } = racingPort([
      { status: 400, code: 'ERROR_CEREMONY_ABORTED' },
      null,
    ]);
    const autofill = port.offerPasskeyAutofill();
    // Let the autofill request reach the client before the button starts.
    await new Promise((resolve) => setImmediate(resolve));
    const outcome = await port.signInWithPasskey();
    releaseAutofill({ status: 400, code: 'ERROR_CEREMONY_ABORTED' });
    assert({
      given:
        'an autofill request still in flight when the button ceremony is aborted',
      should:
        'run the button ceremony again, which then aborts the autofill instead',
      actual: [outcome, calls, await autofill],
      expected: [
        { kind: 'signed-in' },
        ['passkey-autofill', 'passkey', 'passkey'],
        { kind: 'superseded' },
      ],
    });
  });

  test('does not retry an aborted button ceremony with no autofill in flight', async () => {
    const { port, calls } = racingPort([
      { status: 400, code: 'ERROR_CEREMONY_ABORTED' },
    ]);
    assert({
      given: 'a button ceremony aborted while no autofill request is running',
      should: 'report it cancelled after a single attempt',
      actual: [await port.signInWithPasskey(), calls],
      expected: [{ kind: 'cancelled' }, ['passkey']],
    });
  });

  test('an autofill request that throws still stops counting as in flight', async () => {
    const calls: string[] = [];
    const client: SignInClient = {
      signIn: {
        passkey: async (opts) => {
          calls.push(opts?.autoFill ? 'passkey-autofill' : 'passkey');
          if (opts?.autoFill) throw new Error('network down');
          return { error: { status: 400, code: 'ERROR_CEREMONY_ABORTED' } };
        },
      },
    };
    const port = createBetterAuthSignInPort({
      client,
      supportsPasskeys: () => true,
      supportsPasskeyAutofill: async () => true,
    });
    const thrown = await port.offerPasskeyAutofill().then(
      () => 'settled',
      () => 'threw',
    );
    assert({
      given:
        'an autofill request whose client call threw, then an aborted button',
      should:
        'let the throw through for the safe wrapper and not retry the button',
      actual: [thrown, await port.signInWithPasskey(), calls],
      expected: [
        'threw',
        { kind: 'cancelled' },
        ['passkey-autofill', 'passkey'],
      ],
    });
  });
});
