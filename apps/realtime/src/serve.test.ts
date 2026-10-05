import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  OUTBOX_ORIGIN,
  type OutboxPosition,
  type OutboxRow,
} from '@offense-demo/db';
import { serveRealtime } from './serve';
import type { RealtimeApp } from './app';
import { deferred, noopLogger } from './outbox-drain.test-support';

setupRitewayBun();

/**
 * A minimal `RealtimeApp` stand-in: only the fields `serveRealtime` and
 * `createRealtimeServer` actually read. Cast at the boundary, the same
 * pattern `server.test.ts`'s `fakeServer` uses for a Bun `Server`.
 */
function fakeApp(overrides: {
  readonly listenOutbox: () => Promise<{ unlisten: () => Promise<void> }>;
  readonly readOutboxHighWaterMark: () => Promise<OutboxPosition>;
  readonly NODE_ENV?: string;
  readonly runtimeRoleProblems?: () => Promise<readonly string[]>;
}): RealtimeApp {
  return {
    config: { NODE_ENV: overrides.NODE_ENV ?? 'test' },
    isDraining: () => false,
    logger: noopLogger,
    database: {
      runtimeRoleProblems: overrides.runtimeRoleProblems ?? (async () => []),
      health: async () => true,
      checkListen: async () => true,
      listenOutbox: overrides.listenOutbox,
      readOutboxHighWaterMark: overrides.readOutboxHighWaterMark,
      drainOutbox: async (): Promise<readonly OutboxRow[]> => [],
    },
    redis: { health: async () => true },
  } as unknown as RealtimeApp;
}

describe('serveRealtime startup order (RT-2.3b review finding 2)', () => {
  test('never calls serve() until both LISTEN and the high-water mark have resolved', async () => {
    const listenGate = deferred<{ unlisten: () => Promise<void> }>();
    const highWaterMarkGate = deferred<OutboxPosition>();
    const resources = fakeApp({
      listenOutbox: async () => listenGate.promise,
      readOutboxHighWaterMark: () => highWaterMarkGate.promise,
    });
    let serveCalled = false;
    const fakeServe = ((): ReturnType<typeof Bun.serve> => {
      serveCalled = true;
      return { port: 0, stop: async () => {} } as unknown as ReturnType<
        typeof Bun.serve
      >;
    }) as typeof Bun.serve;

    const settled = serveRealtime({
      resources,
      port: 0,
      sink: () => {},
      serve: fakeServe,
    });

    await Promise.resolve();
    const beforeEitherResolves = serveCalled;

    listenGate.resolve({ unlisten: async () => {} });
    await Promise.resolve();
    await Promise.resolve();
    const afterListenOnly = serveCalled;

    highWaterMarkGate.resolve(OUTBOX_ORIGIN);
    await settled;
    const afterBoth = serveCalled;

    assert({
      given:
        'a database whose listenOutbox and readOutboxHighWaterMark are deferred independently',
      should:
        'call serve() only once both have resolved, never before either one',
      actual: { beforeEitherResolves, afterListenOnly, afterBoth },
      expected: {
        beforeEitherResolves: false,
        afterListenOnly: false,
        afterBoth: true,
      },
    });
  });
});

describe('serveRealtime runtime role gate (ISSUE-101)', () => {
  const boot = async (
    NODE_ENV: string,
    problems: readonly string[],
  ): Promise<{
    readonly refused: string | null;
    readonly listened: boolean;
    readonly served: boolean;
  }> => {
    let listened = false;
    let served = false;
    const resources = fakeApp({
      NODE_ENV,
      runtimeRoleProblems: async () => problems,
      listenOutbox: async () => {
        listened = true;
        return { unlisten: async () => {} };
      },
      readOutboxHighWaterMark: async () => OUTBOX_ORIGIN,
    });
    const fakeServe = ((): ReturnType<typeof Bun.serve> => {
      served = true;
      return { port: 0, stop: async () => {} } as unknown as ReturnType<
        typeof Bun.serve
      >;
    }) as typeof Bun.serve;
    try {
      const { drain } = await serveRealtime({
        resources,
        port: 0,
        sink: () => {},
        serve: fakeServe,
      });
      await drain.stop();
      return { refused: null, listened, served };
    } catch (error) {
      return { refused: (error as Error).message, listened, served };
    }
  };

  test('refuses a production role that can alter the schema before LISTEN or serve()', async () => {
    assert({
      given:
        'production config and a DATABASE_URL role that owns schema public',
      should:
        'refuse to start, naming offense_demo_realtime, without subscribing or accepting sockets',
      actual: await boot('production', ['owns schema public']),
      expected: {
        refused:
          'Production refuses a DATABASE_URL role that owns schema public; use the offense_demo_realtime runtime role',
        listened: false,
        served: false,
      },
    });
  });

  test('serves in production as a role with no schema capability', async () => {
    assert({
      given: 'production config and the offense_demo_realtime role',
      should: 'subscribe and serve',
      actual: await boot('production', []),
      expected: { refused: null, listened: true, served: true },
    });
  });
});
