import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { isAPIError } from 'better-auth/api';
import { passkeyOwnershipGuardPlugin } from './passkey-ownership-guard';

setupRitewayBun();

const ownerId = 'owner-user-id';

const context = (
  path: string,
  body: { id?: unknown } | undefined,
  session: { user: { id: string } } | null,
  passkey: { userId?: string } | null,
) => ({
  path,
  body,
  headers: new Headers(),
  context: {
    session: session ? { session: { id: 'sess' }, user: session.user } : null,
    adapter: { findOne: async () => passkey },
  },
});

const beforeHook = () => {
  const hook = passkeyOwnershipGuardPlugin.hooks?.before?.[0];
  if (!hook) throw new Error('plugin defines no before hook');
  return hook;
};

const run = async (
  path: string,
  body: { id?: unknown } | undefined,
  session: { user: { id: string } } | null,
  passkey: { userId?: string } | null,
) => {
  const hook = beforeHook();
  const ctx = context(path, body, session, passkey);
  if (!hook.matcher(ctx as never)) return 'not-matched';
  try {
    await hook.handler(ctx as never);
    return 'allowed';
  } catch (error) {
    if (isAPIError(error)) return `refused:${error.status}`;
    throw error;
  }
};

describe('passkeyOwnershipGuardPlugin matcher', () => {
  test('matches only delete and update passkey paths', () => {
    const hook = beforeHook();
    assert({
      given: 'the mounted passkey management paths and an unrelated one',
      should: 'match delete and update but nothing else',
      actual: [
        '/passkey/delete-passkey',
        '/passkey/update-passkey',
        '/passkey/generate-register-options',
      ].map((path) => hook.matcher(context(path, {}, null, null) as never)),
      expected: [true, true, false],
    });
  });
});

describe('passkeyOwnershipGuardPlugin handler', () => {
  test('refuses with no session', async () => {
    const result = await run('/passkey/delete-passkey', { id: 'p1' }, null, {
      userId: ownerId,
    });
    assert({
      given: 'a delete-passkey request with no session',
      should: 'refuse as unauthorized',
      actual: result,
      expected: 'refused:UNAUTHORIZED',
    });
  });

  test('refuses when the passkey belongs to a different user', async () => {
    const result = await run(
      '/passkey/update-passkey',
      { id: 'p1' },
      { user: { id: 'attacker-id' } },
      { userId: ownerId },
    );
    assert({
      given: "a rename of another user's passkey",
      should: 'refuse as unauthorized before the vendor endpoint runs',
      actual: result,
      expected: 'refused:UNAUTHORIZED',
    });
  });

  test('allows the owner to act on their own passkey', async () => {
    const result = await run(
      '/passkey/delete-passkey',
      { id: 'p1' },
      { user: { id: ownerId } },
      { userId: ownerId },
    );
    assert({
      given: "the owner's own passkey id",
      should: 'let the request through to the vendor endpoint',
      actual: result,
      expected: 'allowed',
    });
  });

  test('leaves an unknown passkey id to the vendor endpoint', async () => {
    const result = await run(
      '/passkey/delete-passkey',
      { id: 'missing' },
      { user: { id: ownerId } },
      null,
    );
    assert({
      given: 'an id that matches no stored passkey',
      should: 'not refuse here; the vendor endpoint answers NOT_FOUND',
      actual: result,
      expected: 'allowed',
    });
  });
});
