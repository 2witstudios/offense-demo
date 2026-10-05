import type { IncomingMessage, ServerResponse } from 'node:http';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createIngressListener } from './ingress';

setupRitewayBun();

type Req = {
  socket: { remoteAddress: string };
  headers: Record<string, string | string[] | undefined>;
};
const request = (peer: string, headers: Req['headers']) =>
  ({
    socket: { remoteAddress: peer },
    headers,
  }) as unknown as IncomingMessage;
const response = () => {
  const calls: string[] = [];
  const fake = {
    headersSent: false,
    writeHead: (status: number) => void calls.push(`head:${status}`),
    end: () => void calls.push('end'),
  };
  return Object.assign(fake as unknown as ServerResponse, { calls });
};

/** Runs one request through the ingress listener and returns the identity
 * header the handler saw. */
const resolvedIdentity = async (
  peer: string,
  headers: Req['headers'],
  trustedProxies: readonly string[],
) => {
  const seen: Array<string | string[] | undefined> = [];
  const listen = createIngressListener({
    clientIdSubkey: 'ingress-test-subkey',
    isDraining: () => false,
    trustedProxies,
    handle: async (req) => {
      seen.push(req.headers['x-offense-demo-client-ip']);
    },
    onError: () => undefined,
  });
  await listen(request(peer, headers), response());
  return seen;
};

describe('ingress listener', () => {
  test('forged identity headers', async () => {
    assert({
      given:
        'a forged x-offense-demo-client-ip and X-Forwarded-For from an untrusted peer',
      should: 'hand the handler the socket peer as identity',
      actual: await resolvedIdentity(
        '203.0.113.9',
        { 'x-offense-demo-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' },
        [],
      ),
      expected: ['203.0.113.9'],
    });
  });

  test('forged chain behind a trusted proxy', async () => {
    assert({
      given: 'a trusted proxy peer and a forged left-most forwarded value',
      should: 'resolve the right-most untrusted hop',
      actual: await resolvedIdentity(
        '10.0.0.5',
        {
          'x-offense-demo-client-ip': '1.1.1.1',
          'x-forwarded-for': '6.6.6.6, 198.51.100.7',
        },
        ['10.0.0.0/8'],
      ),
      expected: ['198.51.100.7'],
    });
  });

  test('a trusted fly-proxy peer resolves identity from Fly-Client-IP, not the forwarded chain', async () => {
    assert({
      given: "a trusted fly-proxy peer carrying Fly's authoritative header",
      should:
        'resolve identity from Fly-Client-IP, ignoring the forwarded chain',
      actual: await resolvedIdentity(
        'fdaa::1',
        {
          'fly-client-ip': '203.0.113.9',
          'x-forwarded-for': '6.6.6.6, 198.51.100.7',
        },
        ['fdaa::/8'],
      ),
      expected: ['203.0.113.9'],
    });
  });

  test('an untrusted peer cannot spoof identity through Fly-Client-IP', async () => {
    assert({
      given: 'a direct, untrusted caller forging Fly-Client-IP',
      should: 'hand the handler the socket peer, ignoring the forged header',
      actual: await resolvedIdentity(
        '203.0.113.9',
        { 'fly-client-ip': '198.51.100.7' },
        ['fdaa::/8'],
      ),
      expected: ['203.0.113.9'],
    });
  });

  test('draining', async () => {
    let handled = 0;
    const res = response();
    const listen = createIngressListener({
      clientIdSubkey: 'ingress-test-subkey',
      isDraining: () => true,
      trustedProxies: [],
      handle: async () => {
        handled += 1;
      },
      onError: () => undefined,
    });
    await listen(request('203.0.113.9', {}), res);
    assert({
      given: 'a draining server',
      should: 'answer 503 without calling the handler',
      actual: { handled, calls: res.calls },
      expected: { handled: 0, calls: ['head:503', 'end'] },
    });
  });

  test('handler failure', async () => {
    const errors: number[] = [];
    const res = response();
    const listen = createIngressListener({
      clientIdSubkey: 'ingress-test-subkey',
      isDraining: () => false,
      trustedProxies: [],
      handle: () => Promise.reject(new Error('boom')),
      onError: () => void errors.push(1),
    });
    await listen(request('203.0.113.9', {}), res);
    assert({
      given: 'a handler that rejects',
      should: 'log once and answer 500',
      actual: { errors, calls: res.calls },
      expected: { errors: [1], calls: ['head:500', 'end'] },
    });
  });
});
