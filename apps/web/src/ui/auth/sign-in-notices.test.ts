import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { signInNotices } from './sign-in-notices';

setupRitewayBun();

describe('sign-in notices (AUTH-3.10.2)', () => {
  test('a rate-limited request gives a minute’s wait and names passkey sign-in, without blaming the person', () => {
    const { tone, title, body } = signInNotices['rate-limited'];
    const text = `${title} ${body}`.toLowerCase();
    assert({
      given:
        'the notice a 429 shows, which may come from a shared network’s limit rather than the person’s own requests',
      should:
        'be an error that says to wait a minute and names signing in with a passkey, and not call it the person’s attempts',
      actual: {
        tone,
        minute: text.includes('a minute'),
        passkey: text.includes('passkey'),
        attempts: text.includes('attempts'),
      },
      expected: { tone: 'error', minute: true, passkey: true, attempts: false },
    });
  });
});
