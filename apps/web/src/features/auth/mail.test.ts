import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { sequentialId } from '@offense-demo/clock';
import { createResendSender } from './mail';

setupRitewayBun();

const message = {
  to: 'player@offense-demo.example.com',
  subject: 'Sign in to Offense Demo',
  text: 'Open https://offense-demo.example.com/auth/confirm?token=SECRETTOKEN',
  html: '<p>x</p>',
};

type Call = { url: string; init: RequestInit };
const scripted = (responses: Array<Response | Error | 'hang'>) => {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next === 'hang')
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    return Promise.resolve(next ?? new Response('{}', { status: 500 }));
  }) as typeof fetch;
  return { calls, fetchImpl };
};
const ok = (id = 'msg_1') =>
  new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
const create = (
  responses: Array<Response | Error | 'hang'>,
  timeoutMs = 10_000,
  elapsed?: () => number,
) => {
  const { calls, fetchImpl } = scripted(responses);
  return {
    calls,
    sender: createResendSender({
      apiKey: 're_test_key',
      from: 'Offense Demo <no-reply@offense-demo.example.com>',
      ids: sequentialId('idem'),
      fetch: fetchImpl,
      timeoutMs,
      ...(elapsed ? { elapsed } : {}),
    }),
  };
};
/** The status class a failed send carries (never its body or recipient). */
const failureOf = (sending: Promise<unknown>) =>
  sending.then(
    () => 'delivered',
    (error: { message: string; transient: boolean; status?: number }) => ({
      message: error.message,
      transient: error.transient,
      status: error.status,
    }),
  );

describe('Resend sender', () => {
  test('posts one message with bearer auth, an idempotency key and no tracking fields', async () => {
    const { sender, calls } = create([ok('msg_abc')]);
    const receipt = await sender.send(message);
    const init = calls[0]?.init ?? {};
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body));
    assert({
      given: 'a valid message',
      should: 'call Resend once and return the provider message ID',
      actual: {
        url: calls[0]?.url,
        method: init.method,
        auth: headers.get('authorization'),
        idempotency: headers.get('idempotency-key'),
        body,
        receipt,
        calls: calls.length,
      },
      expected: {
        url: 'https://api.resend.com/emails',
        method: 'POST',
        auth: 'Bearer re_test_key',
        idempotency: 'idem-1',
        body: {
          from: 'Offense Demo <no-reply@offense-demo.example.com>',
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        receipt: { providerMessageId: 'msg_abc' },
        calls: 1,
      },
    });
  });

  test('retries a transient provider failure once with the same idempotency key', async () => {
    const { sender, calls } = create([
      new Response('{}', { status: 503 }),
      ok('msg_retry'),
    ]);
    const receipt = await sender.send(message);
    const keys = calls.map(({ init }) =>
      new Headers(init.headers).get('idempotency-key'),
    );
    assert({
      given: 'a 503 followed by success',
      should: 'send twice under one key and return the second receipt',
      actual: { keys, receipt },
      expected: {
        keys: ['idem-1', 'idem-1'],
        receipt: { providerMessageId: 'msg_retry' },
      },
    });
  });

  test('retries at most once and then fails without provider detail', async () => {
    const { sender, calls } = create([
      new Response('{"message":"leak player@offense-demo.example.com"}', {
        status: 500,
      }),
      new TypeError('fetch failed'),
      ok(),
    ]);
    let failure = '';
    try {
      await sender.send(message);
    } catch (error) {
      failure = String(error) + JSON.stringify(error);
    }
    assert({
      given: 'two consecutive transient failures',
      should: 'stop after one retry with an error free of recipient/link/key',
      actual: {
        calls: calls.length,
        leaks: [
          'player@offense-demo.example.com',
          'SECRETTOKEN',
          're_test_key',
        ].filter((secret) => failure.includes(secret)),
        failed: failure.length > 0,
      },
      expected: { calls: 2, leaks: [], failed: true },
    });
  });

  test('does not retry a permanent rejection', async () => {
    const { sender, calls } = create([
      new Response('{"name":"validation_error"}', { status: 422 }),
      ok(),
    ]);
    const failure = await failureOf(sender.send(message));
    assert({
      given: 'a 422 provider response',
      should: 'fail as permanent, carrying the status, without a retry',
      actual: { failure, calls: calls.length },
      expected: {
        failure: {
          message: 'Email delivery failed',
          transient: false,
          status: 422,
        },
        calls: 1,
      },
    });
  });

  test('bounds the whole operation by the delivery deadline', async () => {
    // The injected elapsed clock reads 0 when the send starts and the whole
    // 60ms budget once the first attempt has timed out: no retry fits.
    const readings = [0, 60];
    const { sender, calls } = create(['hang', 'hang'], 60, () =>
      Number(readings.shift()),
    );
    const failure = await failureOf(sender.send(message));
    assert({
      given: 'a provider that never answers and a spent 60ms budget',
      should: 'give up after one attempt instead of retrying past the deadline',
      actual: { failure, attempts: calls.length },
      expected: {
        failure: {
          message: 'Email delivery failed',
          transient: true,
          status: undefined,
        },
        attempts: 1,
      },
    });
  });

  test('rejects a success response without a message ID', async () => {
    const { sender } = create([new Response('{}', { status: 200 })]);
    assert({
      given: 'a 200 response whose body has no message ID',
      should: 'fail as permanent rather than report a delivery',
      actual: await failureOf(sender.send(message)),
      expected: {
        message: 'Email delivery failed',
        transient: false,
        status: 200,
      },
    });
  });
});

// The recipient-hashing function moved to recipient-key.ts (recipientKey,
// keyed by a subkey derived from RECIPIENT_HASH_SECRET rather than the raw
// secret directly); see recipient-key.test.ts.
