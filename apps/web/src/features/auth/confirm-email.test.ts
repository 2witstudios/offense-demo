import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { silentLogger } from '../../server/test-loggers.test-support';
import { createConfirmEmailHandlers } from './confirm-email';
import { SESSION_CLEANUP_FAILED_HEADER } from './revoke-others-on-email-change';

setupRitewayBun();

const token = 'a'.repeat(43);
const PUBLIC_APP_URL = 'https://offense-demo.invalid';

/**
 * A fake Better Auth handler answering the one sub-request confirm-email
 * makes (a POST to /email-change/verify with the token in a JSON body). The atomic revoke of every other session now runs
 * inside Better Auth's own after-hook on that endpoint
 * (`revokeOthersOnEmailChangePlugin`), so this fake simulates its outcome
 * the same way the real hook reports it: via a response header.
 */
const handlersWith = (cleanupFailed = false) =>
  createConfirmEmailHandlers({
    logger: silentLogger,
    auth: () => ({
      config: { PUBLIC_APP_URL },
      handler: async (request: Request) => {
        const url = new URL(request.url);
        const body = (await request.json().catch(() => ({}))) as {
          token?: string;
        };
        if (
          request.method === 'POST' &&
          url.pathname === '/api/auth/email-change/verify' &&
          url.search === '' &&
          body.token === token
        )
          return new Response(null, {
            status: 200,
            headers: {
              'set-cookie': 'better-auth.session_token=new; Path=/',
              ...(cleanupFailed
                ? { [SESSION_CLEANUP_FAILED_HEADER]: 'true' }
                : {}),
            },
          });
        return new Response(null, { status: 404 });
      },
    }),
  });

const post = () =>
  new Request(`${PUBLIC_APP_URL}/auth/confirm-email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: PUBLIC_APP_URL,
    },
    body: new URLSearchParams({ token }).toString(),
  });

describe('confirm-email: when the forwarded auth request fails', () => {
  test('renders the expired page instead of propagating the failure', async () => {
    const throwingHandlers = createConfirmEmailHandlers({
      logger: silentLogger,
      auth: () => ({
        config: { PUBLIC_APP_URL },
        handler: async () => {
          throw new Error('redis://secret-host unreachable');
        },
      }),
    });
    const response = await throwingHandlers.POST(post());
    const body = await response.text();
    assert({
      given: 'the composed auth handler throwing (a real outage)',
      should: 'answer 400 with no internal detail, not an unhandled rejection',
      actual: {
        status: response.status,
        leaks: body.includes('redis://secret-host'),
      },
      expected: { status: 400, leaks: false },
    });
  });
});

describe('confirm-email: post-verification session revocation', () => {
  test('redirects to the destination once every other session is confirmed revoked', async () => {
    const response = await handlersWith(false).POST(post());
    assert({
      given: 'a successful verification and revocation',
      should: 'redirect with the new session cookie, not render a warning',
      actual: {
        status: response.status,
        location: response.headers.get('location'),
      },
      expected: { status: 303, location: '/settings/security' },
    });
  });

  test('does not redirect as success when the endpoint flags a failed cleanup', async () => {
    const response = await handlersWith(true).POST(post());
    const body = await response.text();
    assert({
      given: 'a successful verification but a flagged cleanup failure',
      should:
        'answer an error status carrying the new cookie, not the success redirect',
      actual: {
        status: response.status,
        cookieCarried: response.headers.getSetCookie().length > 0,
        mentionsIncomplete: body.includes('cleanup step failed'),
      },
      expected: { status: 502, cookieCarried: true, mentionsIncomplete: true },
    });
  });
});

describe('confirm-email: an approval refused because the new address is suppressed (ISSUE-104)', () => {
  const refusedWith = (code: string) =>
    createConfirmEmailHandlers({
      logger: silentLogger,
      auth: () => ({
        config: { PUBLIC_APP_URL },
        handler: async () => Response.json({ code }, { status: 422 }),
      }),
    });

  test('tells the person the new address cannot receive email', async () => {
    const undeliverable = await refusedWith('EMAIL_UNDELIVERABLE').POST(post());
    const other = await refusedWith('SOMETHING_ELSE').POST(post());
    const [undeliverablePage, otherPage] = await Promise.all([
      undeliverable.text(),
      other.text(),
    ]);
    assert({
      given:
        'the approval hop answering 422 EMAIL_UNDELIVERABLE, next to a 422 with another code',
      should:
        'render the cannot-receive-email page for the suppression only, and the expired-link page otherwise',
      actual: {
        undeliverable: [
          undeliverable.status,
          undeliverablePage.includes('cannot receive email'),
        ],
        other: [other.status, otherPage.includes('can no longer be used')],
      },
      expected: { undeliverable: [422, true], other: [400, true] },
    });
  });
});
