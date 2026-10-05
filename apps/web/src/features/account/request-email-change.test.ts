import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requestEmailChange } from './request-email-change';
import { answering, firstPost } from '../../lib/recorded-post.test-support';
import { jsonResponse } from './security-client.test-support';

setupRitewayBun();

describe('requestEmailChange', () => {
  test('starts the change over the Better Auth route', async () => {
    const { requests, send } = answering(jsonResponse({ status: true }));
    const outcome = await requestEmailChange('new@example.test', send);
    assert({
      given: 'an accepted change',
      should:
        'report ok, having posted only the new address (the emailed links carry no destination, ISSUE-2)',
      actual: { outcome, ...firstPost(requests) },
      expected: {
        outcome: { kind: 'ok' },
        url: '/api/auth/change-email',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { newEmail: 'new@example.test' },
      },
    });
  });

  test('maps refusals from the Better Auth error body', async () => {
    const outcome = async (response: Response | Error) =>
      (await requestEmailChange('x@example.test', answering(response).send))
        .kind;
    assert({
      given:
        'a stale session, a taken address, throttling, bad input, an unreadable body and no answer',
      should:
        'answer stale-session, conflict, rate-limited, invalid, unavailable, unavailable',
      actual: [
        await outcome(
          jsonResponse({ code: 'SESSION_NOT_FRESH', message: 'stale' }, 403),
        ),
        await outcome(jsonResponse({ code: 'EMAIL_TAKEN' }, 409)),
        await outcome(new Response(null, { status: 429 })),
        await outcome(jsonResponse({ code: 'INVALID_EMAIL' }, 400)),
        await outcome(new Response('<html>', { status: 502 })),
        await outcome(new Error('network down')),
      ],
      expected: [
        'stale-session',
        'conflict',
        'rate-limited',
        'invalid',
        'unavailable',
        'unavailable',
      ],
    });
  });

  test('tells an undeliverable new address from an undeliverable address on file (ISSUE-113)', async () => {
    const outcome = async (code: string) =>
      (
        await requestEmailChange(
          'x@example.test',
          answering(jsonResponse({ code, message: 'server copy' }, 422)).send,
        )
      ).kind;
    assert({
      given:
        'a 422 EMAIL_UNDELIVERABLE, a 422 CURRENT_EMAIL_UNDELIVERABLE and a 422 with any other code',
      should: 'answer undeliverable, current-undeliverable and unavailable',
      actual: [
        await outcome('EMAIL_UNDELIVERABLE'),
        await outcome('CURRENT_EMAIL_UNDELIVERABLE'),
        await outcome('SOMETHING_ELSE'),
      ],
      expected: ['undeliverable', 'current-undeliverable', 'unavailable'],
    });
  });
});
