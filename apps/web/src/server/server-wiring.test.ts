import type { AddressInfo } from 'node:net';
import type { Logger } from '@offense-demo/logger';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock, sequentialId } from '@offense-demo/clock';
import {
  CLIENT_ID_HASH_HEADER,
  CLIENT_IP_HEADER,
  clientIdHash,
  deriveClientIdSubkey,
} from '../features/auth/client-ip';
import { createApp } from './app';
import { createProductionServer } from './server-wiring';

setupRitewayBun();

const secret = 'a'.repeat(32);

/**
 * The exact server start.ts builds, on a real loopback socket, from an app
 * and auth config this test controls; a stand-in for Next's handler records
 * the identity headers the app would see.
 */
async function serveProduction(
  trustedProxies: string[],
  routeTable: string | null = null,
) {
  const state = { draining: false };
  const seen: Array<{ ip: unknown; idHash: unknown }> = [];
  const events: string[] = [];
  const logger: Logger = {
    log: (event) => void events.push(event),
    child: () => logger,
  };
  const server = createProductionServer({
    app: {
      auth: () => ({
        config: {
          AUTH_TRUSTED_PROXIES: trustedProxies,
          BETTER_AUTH_SECRET: secret,
        },
      }),
      isDraining: () => state.draining,
      logger,
    },
    handle: async (request, response) => {
      seen.push({
        ip: request.headers[CLIENT_IP_HEADER],
        idHash: request.headers[CLIENT_ID_HASH_HEADER],
      });
      response.end('ok');
    },
    readRouteTable: () => routeTable,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const get = (headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/`, { headers }).then(
      (response) => response.status,
    );
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { state, seen, events, get, close };
}

/** A /proc/net/route whose one default route goes via 127.0.0.1 (host-order hex). */
const LOOPBACK_GATEWAY_TABLE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'lo\t00000000\t0100007F\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  '',
].join('\n');

const forgedHeaders = {
  [CLIENT_IP_HEADER]: '1.1.1.1',
  [CLIENT_ID_HASH_HEADER]: 'forged',
  'x-forwarded-for': '6.6.6.6, 198.51.100.7',
};

describe('createProductionServer (AUTH-3.8 start.ts wiring, ISSUE-158)', () => {
  test('stamps identity through the configured AUTH_TRUSTED_PROXIES, keyed by BETTER_AUTH_SECRET', async () => {
    const { seen, get, close } = await serveProduction(['127.0.0.1']);
    const status = await get(forgedHeaders);
    await close();
    assert({
      given:
        'AUTH_TRUSTED_PROXIES naming the loopback peer and a request forging identity headers',
      should:
        'hand the app the right-most untrusted hop and its hash under the secret-derived subkey, never a caller value',
      actual: { status, seen },
      expected: {
        status: 200,
        seen: [
          {
            ip: '198.51.100.7',
            idHash: clientIdHash(deriveClientIdSubkey(secret), '198.51.100.7'),
          },
        ],
      },
    });
  });

  test("resolves the gateway keyword to the route table's default gateway before the server trusts it (ISSUE-162, ISSUE-172)", async () => {
    const { seen, events, get, close } = await serveProduction(
      ['gateway'],
      LOOPBACK_GATEWAY_TABLE,
    );
    await get(forgedHeaders);
    await close();
    assert({
      given:
        'AUTH_TRUSTED_PROXIES = gateway and a route table whose one default gateway is the loopback peer',
      should:
        'trust that resolved address, handing the app the right-most untrusted hop, and log nothing unresolved',
      actual: { ips: seen.map(({ ip }) => ip), events },
      expected: { ips: ['198.51.100.7'], events: [] },
    });
  });

  test('an unreadable route table trusts nothing for the gateway keyword and logs it (ISSUE-162, ISSUE-172)', async () => {
    const { seen, events, get, close } = await serveProduction(
      ['gateway'],
      null,
    );
    await get(forgedHeaders);
    await close();
    assert({
      given: 'AUTH_TRUSTED_PROXIES = gateway and no readable route table',
      should:
        'fail closed to the socket peer and log ingress.trusted_proxy.unresolved',
      actual: { ips: seen.map(({ ip }) => ip), events },
      expected: {
        ips: ['127.0.0.1'],
        events: ['ingress.trusted_proxy.unresolved'],
      },
    });
  });

  test('with no trusted proxies configured the socket peer is the identity', async () => {
    const { seen, get, close } = await serveProduction([]);
    await get(forgedHeaders);
    await close();
    assert({
      given: 'an empty AUTH_TRUSTED_PROXIES and forged identity headers',
      should: 'hand the app the socket peer, not a forwarded hop',
      actual: seen.map(({ ip }) => ip),
      expected: ['127.0.0.1'],
    });
  });

  test("refuses with 503 before the app once the app's own drain flag is set", async () => {
    const { state, seen, get, close } = await serveProduction([]);
    const before = await get();
    state.draining = true;
    const during = await get();
    await close();
    assert({
      given: 'the app flipping to draining between two requests',
      should: 'serve the first and refuse the second with 503 before the app',
      actual: { before, during, reachedApp: seen.length },
      expected: { before: 200, during: 503, reachedApp: 1 },
    });
  });
});

describe('createProductionServer refuses a start without auth secrets (AUTH-7.0-AC3)', () => {
  test('throws before any server exists, naming the missing fields without values', async () => {
    const app = createApp({
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://unit:unit@localhost:5432/unit',
        REDIS_URL: 'redis://localhost:6379',
        REDIS_NAMESPACE: 'unit-a',
        PUBLIC_APP_URL: 'http://localhost:3000',
        LOG_LEVEL: 'silent',
      },
      fetch: async () => Response.json({}),
      clock: fixedClock('2026-09-28T00:00:00.000Z'),
      ids: sequentialId('wiring'),
    });
    let refusal = '';
    let server: unknown = null;
    try {
      server = createProductionServer({
        app,
        handle: async (_request, response) => {
          response.end('ok');
        },
        readRouteTable: () => null,
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    await app.close();
    assert({
      given: 'an otherwise valid environment with no auth secrets',
      should:
        'refuse to build the server, naming BETTER_AUTH_SECRET and no value',
      actual: {
        serverBuilt: server !== null,
        namesSecret: refusal.includes('BETTER_AUTH_SECRET'),
        leaksDatabaseUrl: refusal.includes('unit:unit'),
      },
      expected: {
        serverBuilt: false,
        namesSecret: true,
        leaksDatabaseUrl: false,
      },
    });
  });
});
