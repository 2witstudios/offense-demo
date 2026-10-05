import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { withoutBrowserHiddenKeys } from './browser-session-shape';

setupRitewayBun();

describe('withoutBrowserHiddenKeys', () => {
  test('drops token and ipAddress at any depth, keeping everything else', () => {
    const expiresAt = new Date('2026-09-30T00:00:00.000Z');
    assert({
      given:
        'a passkey sign-in result with a top-level token and a session row in an array',
      should:
        'remove every token and ipAddress key, and pass Dates and other values through unchanged',
      actual: withoutBrowserHiddenKeys({
        token: 'bearer',
        user: { id: 'u1', email: 'p@offense-demo.example.com' },
        sessions: [
          { id: 's1', token: 'bearer', ipAddress: '203.0.113.9', expiresAt },
        ],
        status: true,
        missing: null,
      }),
      expected: {
        user: { id: 'u1', email: 'p@offense-demo.example.com' },
        sessions: [{ id: 's1', expiresAt }],
        status: true,
        missing: null,
      },
    });
  });
});
