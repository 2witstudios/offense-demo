import type { Server } from 'bun';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Logger } from '@offense-demo/logger';
import {
  createRealtimeServer,
  SOCKET_PATH,
  type RealtimeServerResources,
} from './server';
import type { SocketData } from './socket';

setupRitewayBun();

const noopLogger: Logger = { log: () => {}, child: () => noopLogger };

const resources = (
  overrides: Partial<RealtimeServerResources> = {},
): RealtimeServerResources => ({
  isDraining: () => false,
  database: { health: async () => true, checkListen: async () => true },
  redis: { health: async () => true },
  logger: noopLogger,
  ...overrides,
});

const fakeServer = (upgraded: boolean): Server<SocketData> =>
  ({ upgrade: () => upgraded }) as unknown as Server<SocketData>;

describe('createRealtimeServer socket tuning', () => {
  test('applies the ADR 0031 idle window, frame cap and hard backpressure backstop', () => {
    const { websocket } = createRealtimeServer({ resources: resources() });
    assert({
      given: 'the Bun websocket options',
      should: 'use the ADR-fixed bounds with compression off',
      actual: {
        maxPayloadLength: websocket.maxPayloadLength,
        idleTimeout: websocket.idleTimeout,
        backpressureLimit: websocket.backpressureLimit,
        closeOnBackpressureLimit: websocket.closeOnBackpressureLimit,
        perMessageDeflate: websocket.perMessageDeflate,
      },
      expected: {
        maxPayloadLength: 4096,
        idleTimeout: 36,
        backpressureLimit: 1_048_576,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
      },
    });
  });
});

describe('createRealtimeServer fetch', () => {
  test('answers /health/live without touching resources', async () => {
    const server = createRealtimeServer({ resources: resources() });
    const response = await server.fetch(
      new Request('http://localhost/health/live'),
      fakeServer(false),
    );

    assert({
      given: 'a liveness probe',
      should: 'answer 200 alive',
      actual: { status: response?.status, body: await response?.json() },
      expected: { status: 200, body: { status: 'alive' } },
    });
  });

  test('answers /health/ready 200 when every dependency is healthy', async () => {
    const server = createRealtimeServer({ resources: resources() });
    const response = await server.fetch(
      new Request('http://localhost/health/ready'),
      fakeServer(false),
    );

    assert({
      given: 'Postgres, LISTEN and Redis all healthy',
      should: 'answer 200 ready',
      actual: response?.status,
      expected: 200,
    });
  });

  test('answers /health/ready 503 when draining', async () => {
    const server = createRealtimeServer({
      resources: resources({ isDraining: () => true }),
    });
    const response = await server.fetch(
      new Request('http://localhost/health/ready'),
      fakeServer(false),
    );

    assert({
      given: 'a draining process',
      should: 'answer 503 unavailable',
      actual: { status: response?.status, body: await response?.json() },
      expected: { status: 503, body: { status: 'unavailable' } },
    });
  });

  test('never exposes which dependency is down in the public response', async () => {
    const server = createRealtimeServer({
      resources: resources({ redis: { health: async () => false } }),
    });
    const response = await server.fetch(
      new Request('http://localhost/health/ready'),
      fakeServer(false),
    );

    assert({
      given: 'Redis unhealthy while Postgres and LISTEN are fine',
      should: 'answer 503 with only {status}, never naming the failing check',
      actual: { status: response?.status, body: await response?.json() },
      expected: { status: 503, body: { status: 'unavailable' } },
    });
  });

  test('upgrades a WebSocket request on the socket path', async () => {
    const server = createRealtimeServer({ resources: resources() });
    const response = await server.fetch(
      new Request(`http://localhost${SOCKET_PATH}`),
      fakeServer(true),
    );

    assert({
      given: 'a request Bun successfully upgrades',
      should:
        'return undefined, handing the response to the WebSocket protocol',
      actual: response,
      expected: undefined,
    });
  });

  test('answers 400 on the socket path when the upgrade is refused', async () => {
    const server = createRealtimeServer({ resources: resources() });
    const response = await server.fetch(
      new Request(`http://localhost${SOCKET_PATH}`),
      fakeServer(false),
    );

    assert({
      given: 'a non-WebSocket request to the socket path',
      should: 'answer 400, never falling through to any other route',
      actual: response?.status,
      expected: 400,
    });
  });

  test('answers 404 for any other path', async () => {
    const server = createRealtimeServer({ resources: resources() });
    const response = await server.fetch(
      new Request('http://localhost/anything-else'),
      fakeServer(false),
    );

    assert({
      given: 'a path with no route',
      should: 'answer 404',
      actual: response?.status,
      expected: 404,
    });
  });

  test('logs deliverySeqLagEstimate on /health/ready when an outbox cursor is wired (RT-2.3b-f1 criterion 3)', async () => {
    const events: Array<{
      event: string;
      fields: Record<string, unknown>;
    }> = [];
    const recordingLogger: Logger = {
      log: (event, fields) => {
        events.push({ event, fields });
      },
      child: () => recordingLogger,
    };
    const server = createRealtimeServer({
      resources: resources({
        logger: recordingLogger,
        outbox: {
          cursor: () => ({ txid: '5', seq: 3n }),
          highWaterMark: async () => ({ txid: '5', seq: 10n }),
        },
      }),
    });

    await server.fetch(
      new Request('http://localhost/health/ready'),
      fakeServer(false),
    );

    assert({
      given:
        'a readiness probe with a drain cursor behind a fresh high-water mark',
      should: 'log realtime.outbox.delivery_lag_estimated with the estimate',
      actual: events.filter(
        (event) => event.event === 'realtime.outbox.delivery_lag_estimated',
      ),
      expected: [
        {
          event: 'realtime.outbox.delivery_lag_estimated',
          fields: { deliverySeqLagEstimate: 7 },
        },
      ],
    });
  });

  test('logs nothing for delivery lag when no outbox resource is wired', async () => {
    const events: string[] = [];
    const recordingLogger: Logger = {
      log: (event) => {
        events.push(event);
      },
      child: () => recordingLogger,
    };
    const server = createRealtimeServer({
      resources: resources({ logger: recordingLogger }),
    });

    await server.fetch(
      new Request('http://localhost/health/ready'),
      fakeServer(false),
    );

    assert({
      given: 'a readiness probe with no outbox resource wired',
      should: 'never log realtime.outbox.delivery_lag_estimated',
      actual: events.includes('realtime.outbox.delivery_lag_estimated'),
      expected: false,
    });
  });
});
