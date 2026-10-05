import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { returnableDestination, safeLocalDestination } from './redirect';

setupRitewayBun();

describe('safeLocalDestination', () => {
  test('keeps same-origin local paths with query and hash', () => {
    assert({
      given: 'a local path with a query string',
      should: 'return it unchanged',
      actual: safeLocalDestination('/items/abc?tab=rules#top'),
      expected: '/items/abc?tab=rules#top',
    });
  });

  test('falls back to /app for absent or empty input', () => {
    assert({
      given: 'no destination',
      should: 'use the default /app',
      actual: [
        safeLocalDestination(undefined),
        safeLocalDestination(null),
        safeLocalDestination(''),
      ],
      expected: ['/app', '/app', '/app'],
    });
  });

  test('rejects every external, protocol-relative and encoded bypass', () => {
    const bypasses = [
      'https://evil.example/x',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/%2Fevil.example',
      '/%5Cevil.example',
      '/%252F%252Fevil.example',
      '%2F%2Fevil.example',
      'javascript:alert(1)',
      'data:text/html,x',
      '/\tevil',
      '/\n/evil.example',
      'app',
      '/..%2F..%2F//evil.example',
      '/ok?token=abc',
      '/ok?next=1&token=abc',
    ];
    assert({
      given: 'external, protocol-relative, encoded or token-bearing inputs',
      should: 'all fall back to /app',
      actual: bypasses.map((value) => safeLocalDestination(value)),
      expected: bypasses.map(() => '/app'),
    });
  });

  test('honors an explicit fallback', () => {
    assert({
      given: 'an unsafe value and a custom fallback',
      should: 'return the fallback',
      actual: safeLocalDestination('//evil', '/onboarding/username'),
      expected: '/onboarding/username',
    });
  });
});

describe('returnableDestination (ISSUE-167)', () => {
  test('keeps an ordinary local destination', () => {
    assert({
      given: 'an ordinary local path',
      should: 'keep it, exactly as safeLocalDestination would',
      actual: returnableDestination('/items?tab=open'),
      expected: '/items?tab=open',
    });
  });

  test('falls back for a destination that would loop through sign-in, auth or api, plain or disguised', () => {
    const loops = [
      '/sign-in',
      '/sign-in?next=%2Fapp',
      '/auth/confirm',
      '/api/auth/sign-out',
      '/app/../api/auth/sign-out',
      '/%73ign-in',
      '/%2573ign-in',
      '/app/%2E%2E/auth/confirm',
      '/%61pi/auth/get-session',
      '/./sign-in?next=/app',
    ];
    assert({
      given: 'destinations that resolve to sign-in, auth or api routes',
      should: 'fall back to /app, never return the forbidden route',
      actual: loops.map((value) => returnableDestination(value)),
      expected: loops.map(() => '/app'),
    });
  });

  test('keeps local pages whose names merely start like forbidden routes', () => {
    const lookalikes = [
      '/sign-ins',
      '/apiary',
      '/app/../items',
      '/items?tab=%61',
    ];
    assert({
      given: 'local pages that are not sign-in, auth or api routes',
      should: 'keep them as given',
      actual: lookalikes.map((value) => returnableDestination(value)),
      expected: lookalikes,
    });
  });

  test('honors an explicit fallback for a forbidden destination', () => {
    assert({
      given: 'a forbidden destination and a custom fallback',
      should: 'return the fallback, not /app',
      actual: returnableDestination('/api/x', '/onboarding/username'),
      expected: '/onboarding/username',
    });
  });
});
