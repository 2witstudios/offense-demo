import { type APIRequestContext } from '@playwright/test';
import { expect, test } from './support/fixtures';
import {
  origin,
  signUpProvisional,
  signUpProvisionalResponse,
  uniqueName,
} from './support/accounts';

// The production server (NODE_ENV=production, HTTPS public origin, real
// ingress stamping) with the auth routes mounted. Header behavior is asserted
// on the served responses, not on route-module return values.
const token = 'e2eTokenNotARealCredential0123456789';

test('the confirmation page is scanner-safe under the production server', async ({
  request,
}) => {
  const get = await request.get(`/auth/confirm?token=${token}`);
  const head = await request.head(`/auth/confirm?token=${token}`);
  for (const response of [get, head]) {
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toContain('no-store');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(response.headers()['set-cookie']).toBeUndefined();
  }
  const html = await get.text();
  expect(html).toContain('method="post" action="/auth/confirm"');
  expect(html).not.toMatch(/<script|<link|<img|<iframe/i);
});

test('auth routes answer with correlation, no-store and refuse foreign origins and passwords', async ({
  request,
}) => {
  const session = await request.get('/api/auth/get-session');
  expect(session.status()).toBe(200);
  expect(session.headers()['x-request-id']).toBeTruthy();
  expect(session.headers()['cache-control']).toContain('no-store');

  const foreign = await request.post('/api/auth/sign-in/magic-link', {
    headers: { origin: 'https://evil.example' },
    data: { email: 'someone@example.test' },
  });
  expect(foreign.status()).toBe(403);

  const password = await request.post('/api/auth/sign-in/email', {
    headers: { origin },
    data: { email: 'someone@example.test', password: 'Sup3rSecret!!' },
  });
  expect(password.status()).toBe(404);
  expect(password.headers()['set-cookie']).toBeUndefined();
});

test('a wrong-origin confirmation POST is refused and leaves no cookie', async ({
  request,
}) => {
  const response = await request.post('/auth/confirm', {
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    data: `token=${token}`,
  });
  expect(response.status()).toBe(403);
  expect(response.headers()['set-cookie']).toBeUndefined();
});

// AUTH-7.8: staging's own non-mutating probes cannot capture a session
// cookie (no probe may sign in for real), so this is the one place that
// asserts the actual Set-Cookie attributes on a real sign-in, over the
// production server's HTTPS front.
test('a real sign-in sets a host-only, HttpOnly, Secure, SameSite session cookie', async ({
  request,
}) => {
  const { confirmed } = await signUpProvisionalResponse(request);
  const setCookies = confirmed
    .headersArray()
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .map(({ value }) => value);
  expect(setCookies.length).toBeGreaterThan(0);
  for (const cookie of setCookies) {
    const lower = cookie.toLowerCase();
    expect(lower).toContain('httponly');
    expect(lower).toContain('secure');
    expect(lower).toMatch(/samesite=(lax|strict)/);
    // Host-only: no Domain attribute, so the cookie never reaches a sibling
    // subdomain even if one existed.
    expect(lower).not.toMatch(/;\s*domain=/);
    expect(lower).toMatch(/;\s*path=/);
  }
});

test('the Resend webhook refuses unsigned requests', async ({ request }) => {
  const response = await request.post('/api/webhooks/resend', {
    data: { type: 'email.delivered', data: { email_id: 'msg_e2e' } },
  });
  expect(response.status()).toBe(400);
});

/** The username form's native POST: its target and hidden fields. */
async function usernameFormPost(request: APIRequestContext) {
  const page = '/onboarding/username?next=%2Fapp';
  const html = await (await request.get(page)).text();
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0] ?? '';
  const action = form.match(/\baction="([^"]*)"/)?.[1] ?? '';
  const hidden = [...form.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g)].map(
    (input) => [
      input[0].match(/\bname="([^"]*)"/)?.[1] ?? '',
      (input[0].match(/\bvalue="([^"]*)"/)?.[1] ?? '').replaceAll(
        '&quot;',
        '"',
      ),
    ],
  );
  // An empty action posts back to the page itself.
  return {
    action: action === '' ? page : action.replaceAll('&amp;', '&'),
    hidden,
  };
}

const claimedName = async (request: APIRequestContext) =>
  (
    (await (await request.get('/api/auth/get-session')).json()) as {
      user: { username: string | null };
    }
  ).user.username ?? null;

test('a server action body over the 16 KiB limit is refused before the action runs', async ({
  playwright,
}) => {
  const browser = await playwright.request.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  await signUpProvisional(browser);
  const { action, hidden } = await usernameFormPost(browser);
  expect(hidden.length).toBeGreaterThan(0);
  const post = (username: string, padding: number) =>
    browser.post(action, {
      headers: { origin },
      multipart: {
        ...Object.fromEntries(hidden),
        username,
        ...(padding > 0 ? { padding: 'x'.repeat(padding) } : {}),
      },
      maxRedirects: 0,
    });

  // Well-formed, and only oversized: nothing is claimed.
  const oversized = await post(uniqueName('big'), 17 * 1024);
  expect(oversized.status()).toBe(500);
  expect(await claimedName(browser)).toBeNull();

  // The control: the same post under the limit claims and moves on.
  const name = uniqueName('small');
  const small = await post(name, 1024);
  expect(small.status()).toBe(303);
  expect(await claimedName(browser)).toBe(name);
  await browser.dispose();
});
