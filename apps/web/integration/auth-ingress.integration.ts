import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createTestApp, origin } from './fixtures';
import { requestFrom } from './socket-request';
import {
  CLIENT_IP_HEADER,
  stampClientIdentity,
} from '../src/features/auth/client-ip';
import { requireTestServices } from '@offense-demo/config';

requireTestServices(process.env);
setupRitewayBun();
// The ingress requests reach the production sender: its mail lands on this
// suite's private mailbox rather than the network.
const { routes, freshEmail } = createTestApp();
const authRoute = routes.auth;

/** Stand-in for the deployment ingress: the same stamping start.ts performs. */
async function ingress(trustedProxies: string[]) {
  const toRequest = (incoming: IncomingMessage) => {
    stampClientIdentity(incoming, trustedProxies, 'ingress-integration-subkey');
    return requestFrom(incoming);
  };
  const server = createServer((incoming, outgoing) => {
    void toRequest(incoming)
      .then((request) => authRoute.POST(request))
      .then(async (response) => {
        outgoing.writeHead(response.status);
        outgoing.end(await response.text());
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    post: (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, ...headers },
        body: JSON.stringify({ email: freshEmail() }),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('AUTH-3.4 trusted ingress identity', () => {
  test('forged forwarding and identity headers cannot evade the limit or reset the counter', async () => {
    const edge = await ingress([]);
    try {
      const responses: Response[] = [];
      for (let index = 0; index < 8; index += 1)
        responses.push(
          await edge.post({
            'x-forwarded-for': `203.0.113.${index + 1}, 198.51.100.${index + 9}`,
            'x-real-ip': `203.0.113.${index + 50}`,
            [CLIENT_IP_HEADER]: `192.0.2.${index + 1}`,
          }),
        );
      assert({
        given:
          'eight requests from one socket peer, each forging a different X-Forwarded-For and identity header',
        should: 'still be limited as one client: 3 admitted, 5 rejected',
        actual: responses.map((response) => response.status),
        expected: [200, 200, 200, 429, 429, 429, 429, 429],
      });
    } finally {
      await edge.close();
    }
  });

  test('behind a configured trusted proxy the real client is read from the right of the chain', async () => {
    const edge = await ingress(['127.0.0.1/32', '::1/128']);
    try {
      const realA = '198.51.100.201';
      const realB = '198.51.100.202';
      const viaA = [];
      for (let index = 0; index < 5; index += 1)
        viaA.push(
          await edge.post({
            // The left-most entry is caller-controlled; only the hop appended
            // by the trusted proxy (right-most) identifies the client.
            'x-forwarded-for': `203.0.113.${index + 1}, ${realA}`,
          }),
        );
      const viaB = await edge.post({
        'x-forwarded-for': `203.0.113.1, ${realB}`,
      });
      assert({
        given:
          'a trusted proxy forwarding two real clients while a caller prepends spoofed addresses',
        should:
          'limit each real client independently and ignore the spoofed entries',
        actual: {
          clientA: viaA.map((response) => response.status),
          clientB: viaB.status,
        },
        expected: { clientA: [200, 200, 200, 429, 429], clientB: 200 },
      });
    } finally {
      await edge.close();
    }
  });
});
