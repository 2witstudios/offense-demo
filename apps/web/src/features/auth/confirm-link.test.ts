import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { buildConfirmLink } from './confirm-link';

setupRitewayBun();

const betterAuthUrl = (params: Record<string, string>) =>
  `https://offense-demo.invalid/api/auth/magic-link/verify?${new URLSearchParams(
    {
      token: 'a'.repeat(32),
      ...params,
    },
  )}`;

describe('buildConfirmLink', () => {
  test('keeps a requested local destination', () => {
    const link = buildConfirmLink(
      'https://offense-demo.invalid',
      betterAuthUrl({ callbackURL: '/items', newUserCallbackURL: '/settings' }),
    );
    assert({
      given: 'requested destinations on ordinary local pages',
      should: 'carry both into the emailed confirm link',
      actual: [
        link.searchParams.get('callbackURL'),
        link.searchParams.get('newUserCallbackURL'),
      ],
      expected: ['/items', '/settings'],
    });
  });

  test('never emails a link that returns to sign-in, auth or api routes (ISSUE-167)', () => {
    const link = buildConfirmLink(
      'https://offense-demo.invalid',
      betterAuthUrl({
        callbackURL: '/api/auth/sign-out',
        newUserCallbackURL: '/%73ign-in',
      }),
    );
    assert({
      given:
        'requested destinations naming an api route and an encoded sign-in page',
      should: 'replace both with the signed-in home in the emailed link',
      actual: [
        link.searchParams.get('callbackURL'),
        link.searchParams.get('newUserCallbackURL'),
      ],
      expected: ['/app', '/app'],
    });
  });
});
