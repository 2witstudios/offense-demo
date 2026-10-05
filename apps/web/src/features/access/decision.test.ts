import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Identity } from '@offense-demo/auth';
import {
  decideAccess,
  nextDestination,
  onboardingHref,
  passkeyOfferHref,
  requirementFor,
  signInHref,
  isGuardedPath,
  requestedPath,
} from './decision';

setupRitewayBun();

const anonymous: Identity = {
  state: 'anonymous',
  principal: { kind: 'anonymous' },
};
const provisional: Identity = {
  state: 'provisional',
  principal: { kind: 'user', userId: 'u' },
};
const member: Identity = {
  state: 'member',
  username: 'ada',
  principal: { kind: 'user', userId: 'u' },
};

describe('decideAccess', () => {
  test('an anonymous visitor is sent to sign-in carrying the local path', () => {
    assert({
      given: 'an anonymous request for /app',
      should: 'redirect to /sign-in with next=/app',
      actual: decideAccess({
        identity: anonymous,
        path: '/app',
        requirement: 'participant',
      }),
      expected: { kind: 'redirect', to: '/sign-in?next=%2Fapp' },
    });
  });

  test('a provisional account is sent to onboarding before participant pages', () => {
    assert({
      given: 'a provisional account requesting /app/items',
      should: 'redirect to username onboarding carrying the path',
      actual: decideAccess({
        identity: provisional,
        path: '/app/items',
        requirement: 'participant',
      }),
      expected: {
        kind: 'redirect',
        to: '/onboarding/username?next=%2Fapp%2Fitems',
      },
    });
  });

  test('a provisional account may reach account pages', () => {
    assert({
      given: 'a provisional account requesting the account requirement',
      should: 'allow it',
      actual: decideAccess({
        identity: provisional,
        path: '/settings',
        requirement: 'account',
      }),
      expected: { kind: 'allow' },
    });
  });

  test('a member reaches participant pages', () => {
    assert({
      given: 'a member requesting a participant page',
      should: 'allow it',
      actual: decideAccess({
        identity: member,
        path: '/app/items',
        requirement: 'participant',
      }),
      expected: { kind: 'allow' },
    });
  });

  test('the carried path can never be an absolute or protocol-relative URL', () => {
    const to = (path: string) =>
      decideAccess({
        identity: anonymous,
        path,
        requirement: 'participant',
      });
    assert({
      given: 'hostile paths',
      should: 'fall back to the signed-in home destination',
      actual: [to('//evil.example/x'), to('https://evil.example/')],
      expected: [
        { kind: 'redirect', to: '/sign-in?next=%2Fapp' },
        { kind: 'redirect', to: '/sign-in?next=%2Fapp' },
      ],
    });
  });
});

describe('decideAccess during a session-store outage', () => {
  test('refuses as unavailable instead of sending a member to sign-in', () => {
    const unavailable: Identity = {
      state: 'unavailable',
      principal: { kind: 'anonymous' },
    };
    assert({
      given: 'an unreadable session store for participant and account pages',
      should: 'answer unavailable for both, never a sign-in redirect',
      actual: [
        decideAccess({
          identity: unavailable,
          path: '/app',
          requirement: 'participant',
        }),
        decideAccess({
          identity: unavailable,
          path: '/settings',
          requirement: 'account',
        }),
      ],
      expected: [{ kind: 'unavailable' }, { kind: 'unavailable' }],
    });
  });
});

describe('isGuardedPath', () => {
  test('the configured areas and their descendants are guarded', () => {
    assert({
      given: 'guarded roots, descendants, lookalikes and public routes',
      should: 'guard only the roots and their descendants',
      actual: [
        '/app',
        '/settings',
        '/app/abc',
        '/app/items/new',
        '/settings/security',
        '/application',
        '/apps',
        '/sign-in',
        '/',
      ].map(isGuardedPath),
      expected: [true, true, true, true, true, false, false, false, false],
    });
  });
});

describe('requestedPath', () => {
  test('keeps the page query, repeated keys included', () => {
    assert({
      given: 'no query, one value, repeated values and an empty entry',
      should: 'rebuild the local path with its query',
      actual: [
        requestedPath('/app', {}),
        requestedPath('/app', { tab: 'open' }),
        requestedPath('/app/items', { f: ['a', 'b'], skip: undefined }),
      ],
      expected: ['/app', '/app?tab=open', '/app/items?f=a&f=b'],
    });
  });

  test('the rebuilt path survives the sign-in redirect', () => {
    assert({
      given: 'an anonymous request for /app?tab=open',
      should: 'carry the query in next',
      actual: decideAccess({
        identity: { state: 'anonymous', principal: { kind: 'anonymous' } },
        path: requestedPath('/app', { tab: 'open' }),
        requirement: 'participant',
      }),
      expected: { kind: 'redirect', to: '/sign-in?next=%2Fapp%3Ftab%3Dopen' },
    });
  });
});

describe('requirementFor', () => {
  test('each guarded area has one requirement, inherited by descendants', () => {
    assert({
      given: 'guarded roots, descendants, lookalikes and public routes',
      should: 'answer participant, account or null',
      actual: [
        '/app/items',
        '/app/abc',
        '/settings/security',
        '/apps',
        '/about',
        '/',
      ].map((path) => requirementFor(path)),
      expected: ['participant', 'participant', 'account', null, null, null],
    });
  });
});

describe('return links', () => {
  test('read next from the query and build sign-in and onboarding links', () => {
    assert({
      given: 'a query next, a repeated next, a hostile next and a destination',
      should: 'validate next and encode the destination as one value',
      actual: [
        nextDestination({ next: '/app/items?tab=a' }),
        nextDestination({ next: ['/app/b', '/app/c'] }),
        nextDestination({ next: '//evil.example' }),
        signInHref('/app?tab=a&b=1'),
        onboardingHref('/app/items'),
        signInHref(onboardingHref('/app/items')),
        passkeyOfferHref('/app?tab=a'),
      ],
      expected: [
        '/app/items?tab=a',
        '/app/b',
        '/app',
        '/sign-in?next=%2Fapp%3Ftab%3Da%26b%3D1',
        '/onboarding/username?next=%2Fapp%2Fitems',
        '/sign-in?next=%2Fonboarding%2Fusername%3Fnext%3D%252Fapp%252Fitems',
        '/onboarding/passkey?next=%2Fapp%3Ftab%3Da',
      ],
    });
  });
});
