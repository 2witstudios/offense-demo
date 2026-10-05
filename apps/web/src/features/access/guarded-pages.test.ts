import { join } from 'node:path';
import { mock } from 'bun:test';
import { Glob } from 'bun';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { appConfig } from '../../app-config';
import { guardedAreaFor, isGuardedPath } from './decision';

setupRitewayBun();

const appDir = join(import.meta.dir, '../../app');

/** `app/(shell)/app/[id]/page.tsx` → `/app/[id]`; route groups `(x)` vanish. */
const routeOf = (file: string): string =>
  `/${file
    .replace(/\/?page\.tsx$/, '')
    .split('/')
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
    .join('/')}`;

// Every page renders with a recording guard in place of the real one (which
// reads the request's cookies through the process app): the test invokes
// the page itself and observes what it asks the guard for.
const guardCalls: Array<{ path: string; searchParams: unknown }> = [];
mock.module(join(import.meta.dir, '../../lib/access.ts'), () => ({
  requireAccess: async (path: string, searchParams: unknown) => {
    guardCalls.push({ path, searchParams });
    return { state: 'anonymous' };
  },
}));
// Public pages that only read who is asking (the home page) get an
// anonymous visitor instead of the request's cookies.
mock.module(join(import.meta.dir, '../../lib/request-session.ts'), () => ({
  requestIdentity: async () => ({ state: 'anonymous' }),
}));
// The settings screen's client component is not under test here; loading it
// would only add code this suite never runs.
mock.module(
  join(import.meta.dir, '../../ui/settings/security/security-page.tsx'),
  () => ({ SecurityPage: () => null }),
);

type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string>>;
}) => unknown;

// The pages this suite renders, by file: every guarded page and every public
// page. The tests fail on a page the glob finds but this misses. Loaded
// lazily, after the mocks above, so no page pulls in the real guard.
const rendered: Readonly<Record<string, () => Promise<{ default: unknown }>>> =
  {
    '(shell)/app/page.tsx': () => import('../../app/(shell)/app/page'),
    '(shell)/settings/page.tsx': () =>
      import('../../app/(shell)/settings/page'),
    '(shell)/settings/security/page.tsx': () =>
      import('../../app/(shell)/settings/security/page'),
    '(shell)/page.tsx': () => import('../../app/(shell)/page'),
  };

/** What a page asked the guard when rendered with its own search params. */
const guardRequestsOf = async (file: string) => {
  const load = rendered[file];
  if (!load) return [{ root: 'not rendered by this suite', file }];
  const page = (await load()).default as Page;
  const searchParams = Promise.resolve({ from: 'test' });
  guardCalls.length = 0;
  try {
    await page({
      params: Promise.resolve({ id: 'x' }),
      searchParams,
    });
  } catch (error) {
    // A page may answer 404 for the placeholder id; the guard ran first.
    if (
      !String((error as { digest?: unknown }).digest).startsWith(
        'NEXT_HTTP_ERROR_FALLBACK',
      )
    )
      throw error;
  }
  return guardCalls.map((call) => ({
    root: guardedAreaFor(call.path),
    ownSearchParams: call.searchParams === searchParams,
  }));
};

/** Renders pages one at a time: they share the recording guard. */
const requestsOf = async (files: readonly { file: string }[]) => {
  const results: Array<{
    file: string;
    requests: Awaited<ReturnType<typeof guardRequestsOf>>;
  }> = [];
  for (const { file } of files)
    results.push({ file, requests: await guardRequestsOf(file) });
  return results;
};

const pages = [...new Glob('**/page.tsx').scanSync(appDir)]
  .map((file) => ({ file, route: routeOf(file) }))
  .sort((a, b) => a.file.localeCompare(b.file));

describe('guarded pages', () => {
  test('every page in a guarded area rechecks the session for its own root', async () => {
    const guarded = pages.filter(({ route }) => isGuardedPath(route));
    assert({
      given: 'the page files the glob found under guarded roots',
      should: 'cover every guarded root, so an empty scan cannot pass',
      actual: [
        ...new Set(guarded.map(({ route }) => guardedAreaFor(route))),
      ].sort(),
      expected: Object.keys(appConfig.guardedAreas).sort(),
    });
    const requests = await requestsOf(guarded);
    assert({
      given: `the ${guarded.length} page files under the guarded roots, each rendered`,
      should:
        'call requireAccess once with its own guarded area and its own search params (the requirement comes from the guarded-area table)',
      actual: requests,
      expected: guarded.map(({ file, route }) => ({
        file,
        requests: [{ root: guardedAreaFor(route), ownSearchParams: true }],
      })),
    });
  });

  test('public shell pages do not demand an account', async () => {
    const publicPages = pages.filter(
      ({ file, route }) => file in rendered && !isGuardedPath(route),
    );
    assert({
      given: 'the public pages this suite renders, each rendered',
      should: 'not call requireAccess',
      actual: await requestsOf(publicPages),
      expected: publicPages.map(({ file }) => ({ file, requests: [] })),
    });
  });
});
