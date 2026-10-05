import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { resolveIdentity, type VerifiedSession } from './identity';

setupRitewayBun();

const now = () => '2026-01-01T12:00:00.000Z';
const session = (
  overrides: Partial<VerifiedSession> = {},
): VerifiedSession => ({
  userId: 'user1',
  emailVerified: true,
  username: 'ada',
  expiresAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});
const resolveWith = (found: VerifiedSession | null, cookie = 'c=1') =>
  resolveIdentity({ cookie, readSession: async () => found, now });

describe('resolveIdentity', () => {
  test('a verified, unexpired session with a username is a member', async () => {
    assert({
      given: 'a live session whose user completed onboarding',
      should: 'resolve to a member user principal',
      actual: await resolveWith(session()),
      expected: {
        state: 'member',
        username: 'ada',
        principal: { kind: 'user', userId: 'user1' },
      },
    });
  });

  test('a session without a username is provisional', async () => {
    assert({
      given: 'a verified user who has not claimed a username',
      should: 'resolve to a provisional user principal',
      actual: await resolveWith(session({ username: null })),
      expected: {
        state: 'provisional',
        principal: { kind: 'user', userId: 'user1' },
      },
    });
  });

  test('absent, unverified and expired sessions are anonymous', async () => {
    const anonymous = { state: 'anonymous', principal: { kind: 'anonymous' } };
    assert({
      given: 'no session, an unverified email and an expired session',
      should: 'all resolve anonymous',
      actual: [
        await resolveWith(null),
        await resolveWith(session({ emailVerified: false })),
        await resolveWith(session({ expiresAt: '2026-01-01T12:00:00.000Z' })),
        await resolveWith(session({ expiresAt: 'not a date' })),
      ],
      expected: [anonymous, anonymous, anonymous, anonymous],
    });
  });

  test('a missing cookie skips the lookup', async () => {
    let looked = false;
    const result = await resolveIdentity({
      cookie: null,
      readSession: async () => {
        looked = true;
        return session();
      },
      now,
    });
    assert({
      given: 'a request with no cookie header',
      should: 'resolve anonymous without reading a session',
      actual: [result.state, looked],
      expected: ['anonymous', false],
    });
  });

  test('a failing lookup resolves unavailable, never a guess', async () => {
    const result = await resolveIdentity({
      cookie: 'c=1',
      readSession: async () => {
        throw new Error('database down');
      },
      now,
    });
    assert({
      given: 'a session store that throws',
      should: 'fail closed as unavailable, with no user principal',
      actual: result,
      expected: { state: 'unavailable', principal: { kind: 'anonymous' } },
    });
  });

  test('request-supplied roles and identity fields are ignored', async () => {
    const forged = {
      ...session({ username: null }),
      permissions: ['app:write'],
      role: 'admin',
      kind: 'service',
    } as VerifiedSession;
    assert({
      given: 'a lookup result carrying extra role, permission and kind fields',
      should: 'derive the principal only from the verified facts',
      actual: (await resolveWith(forged)).principal,
      expected: { kind: 'user', userId: 'user1' },
    });
  });
});
