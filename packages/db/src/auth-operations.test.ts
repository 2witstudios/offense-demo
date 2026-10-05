import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestDatabase } from './index.test-support';

setupRitewayBun();

describe('sign-in session address guard (ISSUE-103)', () => {
  test('deletes the session in one statement only when its account no longer holds the address', async () => {
    const moved = createTestDatabase([[['session-row-id']]]);
    const held = createTestDatabase([[]]);

    const revoked = await moved.database.revokeSessionUnlessAddressHeld({
      token: 'new-session',
      email: 'old@example.test',
    });
    const kept = await held.database.revokeSessionUnlessAddressHeld({
      token: 'new-session',
      email: 'old@example.test',
    });

    const statement = moved.queries[0]?.query.toLowerCase() ?? '';
    assert({
      given:
        'a just-created session and the address the sign-in proved, once with the account moved and once not',
      should:
        'issue a single DELETE of that session guarded by NOT EXISTS on the account at that address, and report whether it removed it',
      actual: {
        revoked,
        kept,
        statements: moved.queries.length,
        deletes: statement.startsWith('delete from "session"'),
        guarded:
          statement.includes('not exists') && statement.includes('"users"'),
        params: moved.queries[0]?.params,
      },
      expected: {
        revoked: true,
        kept: false,
        statements: 1,
        deletes: true,
        guarded: true,
        params: ['new-session', 'old@example.test'],
      },
    });
  });
});
