import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { moveOn } from './form-action';

setupRitewayBun();

describe('moveOn', () => {
  test('a hydrated page is handed the destination to navigate to itself', () => {
    assert({
      given: "an action called by the page's script (Next's action header)",
      should:
        'return the destination, never redirect() (which makes Next fetch it from the public origin with the cookies)',
      actual: moveOn(
        new Headers({ 'next-action': 'a1b2' }),
        '/onboarding/passkey',
      ),
      expected: { next: '/onboarding/passkey' },
    });
  });

  test('a form posted without JavaScript is redirected', () => {
    const thrown = (() => {
      try {
        moveOn(new Headers(), '/onboarding/passkey');
        return undefined;
      } catch (error) {
        // NEXT_REDIRECT;<type>;<url>;<status>; — an action sends it as 303.
        return String((error as { digest?: unknown }).digest)
          .split(';')
          .slice(0, 3)
          .join(';');
      }
    })();
    assert({
      given: 'a native form post, which carries no action header',
      should: "throw Next's redirect to the destination",
      actual: thrown,
      expected: 'NEXT_REDIRECT;replace;/onboarding/passkey',
    });
  });
});
