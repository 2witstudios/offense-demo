import { afterAll } from 'bun:test';
import type { Socket } from 'bun';
import { systemClock, systemId, type Clock } from '@offense-demo/clock';
import { createApp } from '../src/server/app';
import { createRoutes } from '../src/server/routes';
import { testDatabaseUrl, testRedisUrl, type TestApp } from './fixtures';

/**
 * A pausable TCP relay in front of a real service (PostgreSQL or Redis),
 * for AUTH-6.7 AC3: the shared local stack (ADR 0034) can never be stopped
 * or reconfigured, so an outage-and-recovery proof needs a controllable
 * point of failure this checkout owns instead. `pause()` refuses new
 * connections and terminates every connection currently open through the
 * proxy, simulating the dependency vanishing mid-request; `resume()` lets
 * new connections through again, simulating it coming back. Only a raw byte
 * relay: no protocol awareness, so it works for both PostgreSQL and Redis.
 */
export type FaultProxy = {
  readonly hostname: string;
  readonly port: number;
  pause(): void;
  /**
   * Keeps every connection open but relays nothing in either direction: a
   * dependency that stops answering rather than refusing (ISSUE-208). A
   * stalled connection has lost bytes, so it is not usable after resume.
   */
  stall(): void;
  resume(): void;
  isPaused(): boolean;
  close(): void;
};

type RelayState = { upstream?: Socket; buffered: Uint8Array[] };

function createFaultProxy(target: {
  readonly hostname: string;
  readonly port: number;
}): FaultProxy {
  let paused = false;
  let stalled = false;
  const relays = new Map<Socket, RelayState>();

  const flush = (state: RelayState) => {
    if (!state.upstream) return;
    for (const chunk of state.buffered) state.upstream.write(chunk);
    state.buffered = [];
  };

  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        if (paused) {
          client.terminate();
          return;
        }
        const state: RelayState = { buffered: [] };
        relays.set(client, state);
        Bun.connect({
          hostname: target.hostname,
          port: target.port,
          socket: {
            data: (_upstream, data) => {
              if (!stalled) client.write(data);
            },
            close: () => {
              client.end();
            },
            error: () => {
              client.terminate();
            },
          },
        })
          .then((upstream) => {
            // The client disconnected (or the proxy paused) while the
            // upstream dial was still in flight; give the connection no home.
            if (!relays.has(client)) {
              upstream.terminate();
              return;
            }
            state.upstream = upstream;
            flush(state);
          })
          .catch(() => client.terminate());
      },
      data(client, data) {
        const state = relays.get(client);
        if (!state || stalled) return;
        if (state.upstream) state.upstream.write(data);
        else state.buffered.push(new Uint8Array(data));
      },
      close(client) {
        relays.get(client)?.upstream?.end();
        relays.delete(client);
      },
      error(client) {
        relays.get(client)?.upstream?.terminate();
        relays.delete(client);
      },
    },
  });

  return {
    hostname: '127.0.0.1',
    port: listener.port,
    pause() {
      paused = true;
      for (const client of relays.keys()) client.terminate();
      relays.clear();
    },
    stall() {
      stalled = true;
    },
    resume() {
      paused = false;
      stalled = false;
    },
    isPaused: () => paused,
    close: () => listener.stop(true),
  };
}

/** `url` with its host and port replaced by the proxy's, scheme preserved. */
function throughProxy(url: string, proxy: FaultProxy): string {
  const parsed = new URL(url);
  parsed.hostname = proxy.hostname;
  parsed.port = String(proxy.port);
  return parsed.toString();
}

/**
 * A second app over `testApp`'s environment and mailbox with one real
 * service (PostgreSQL or Redis) behind a pausable fault proxy this suite
 * owns, for outage proofs; the shared stack itself is never stopped (ADR
 * 0034). Its log output is discarded, and both close after the suite. Pass
 * a clock to step time through an outage.
 */
export function createFaultedApp(
  testApp: TestApp,
  service: 'DATABASE_URL' | 'REDIS_URL',
  clock: Clock = systemClock,
) {
  const url = (
    service === 'DATABASE_URL' ? testDatabaseUrl : testRedisUrl
  ) as string;
  const target = new URL(url);
  const proxy = createFaultProxy({
    hostname: target.hostname,
    port: Number(target.port),
  });
  const app = createApp({
    env: { ...testApp.env, [service]: throughProxy(url, proxy) },
    fetch: testApp.mailbox.fetch,
    clock,
    ids: systemId,
    logDestination: { write: () => {} },
  });
  afterAll(async () => {
    proxy.close();
    await app.close();
  });
  return { app, proxy, routes: createRoutes(app) };
}
