import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { hasSessionCookie } from './session-cookie';

setupRitewayBun();

const withCookie = (cookie?: string) =>
  hasSessionCookie(new Headers(cookie === undefined ? {} : { cookie }));

describe('hasSessionCookie', () => {
  test('recognizes only a Better Auth session cookie', () => {
    assert({
      given: 'no cookie, unrelated cookies, a lookalike and both real names',
      should: 'answer true only when a session cookie is present',
      actual: [
        withCookie(),
        withCookie('x=1; offense-demo-theme=dark'),
        withCookie('better-auth.session_token_fake=1'),
        withCookie('x=1; better-auth.session_token=abc.def'),
        withCookie('__Secure-better-auth.session_token=abc'),
      ],
      expected: [false, false, false, true, true],
    });
  });
});
