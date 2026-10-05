import { connect, type AddressInfo } from 'node:net';
import type { Logger } from '@offense-demo/logger';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { startProductionServer } from './listen-first';

setupRitewayBun();

/** A promise this test settles by hand: Next's prepare() still running. */
function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Instants the clock hands out in order: listening, then ready. */
function steppedClock(instants: readonly string[]) {
  let index = 0;
  return { now: () => instants[Math.min(index++, instants.length - 1)]! };
}

/**
 * Exactly what start.ts runs (startProductionServer), on a real loopback
 * socket, with a stand-in for Next whose handler records what reached it
 * and whose prepare() and the runtime-role refusal this test holds open.
 */
function startProduction({ refusalPending = false } = {}) {
  const events: Array<{ event: string; fields: unknown }> = [];
  const started = deferred();
  const logger: Logger = {
    log: (event, fields) => {
      events.push({ event, fields });
      if (event === 'server.start') started.resolve();
    },
    child: () => logger,
  };
  const reached: string[] = [];
  const steps: string[] = [];
  const preparing = deferred();
  const refusing = deferred();
  if (!refusalPending) refusing.resolve();
  const { server, started: starting } = startProductionServer({
    app: {
      auth: () => ({
        config: {
          AUTH_TRUSTED_PROXIES: [],
          BETTER_AUTH_SECRET: 'a'.repeat(32),
        },
      }),
      isDraining: () => false,
      logger,
      clock: steppedClock([
        '2026-09-29T00:00:00.000Z',
        '2026-09-29T00:00:07.250Z',
      ]),
    },
    nextApp: {
      getRequestHandler: () => async (request, response) => {
        reached.push(request.url ?? '');
        response.end('next');
      },
      prepare: () => {
        steps.push('prepare');
        return preparing.promise;
      },
    },
    refuseRole: () => {
      steps.push('refuseRole');
      return refusing.promise;
    },
    readRouteTable: () => null,
    port: 0,
    host: '127.0.0.1',
  });
  /** Resolves once start-up has logged server.start: the port is open. */
  const listening = () => started.promise;
  const get = async (path: string) => {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.text() };
  };
  /** One raw request line, unnormalized, as a client could send it. */
  const rawStatus = (target: string) =>
    new Promise<number>((resolve, reject) => {
      const { port } = server.address() as AddressInfo;
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`,
        ),
      );
      let text = '';
      socket.on('data', (chunk) => (text += chunk.toString()));
      socket.on('end', () => resolve(Number(text.split(' ')[1] ?? 0)));
      socket.on('error', reject);
    });
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return {
    rawStatus,
    events,
    reached,
    steps,
    preparing,
    refusing,
    started: starting,
    listening,
    get,
    close,
  };
}

describe('startProductionServer (ISSUE-172)', () => {
  test('opens the port before prepare settles and answers 503 on readiness until it does', async () => {
    const { reached, preparing, started, listening, get, close } =
      startProduction();
    await listening();
    const whilePreparing = {
      ready: (await get('/api/health/ready')).status,
      page: (await get('/')).status,
      reachedNext: reached.length,
    };
    preparing.resolve();
    await started;
    const afterPrepare = {
      ready: (await get('/api/health/ready')).body,
      page: (await get('/')).body,
    };
    await close();
    assert({
      given: 'a prepare step that has not settled yet',
      should:
        'accept connections, answer 503 without reaching Next, then hand every request to Next once prepared',
      actual: { whilePreparing, afterPrepare },
      expected: {
        whilePreparing: { ready: 503, page: 503, reachedNext: 0 },
        afterPrepare: { ready: 'next', page: 'next' },
      },
    });
  });

  test('answers liveness while preparing: the process is alive', async () => {
    const { preparing, started, listening, get, close } = startProduction();
    await listening();
    const live = await get('/api/health/live?probe=fly');
    preparing.resolve();
    await started;
    await close();
    assert({
      given: 'a liveness probe during prepare',
      should: 'answer 200 alive, the same body as the Next route',
      actual: live,
      expected: { status: 200, body: '{"status":"alive"}' },
    });
  });

  test('logs server.start when listening and server.ready with the prepare duration', async () => {
    const { events, preparing, started, listening, close } = startProduction();
    await listening();
    const beforePrepare = events.map(({ event }) => event);
    preparing.resolve();
    await started;
    await close();
    assert({
      given: 'a prepare step taking 7.25 s on the injected clock',
      should:
        'log server.start before prepare settles, then server.ready with durationMs',
      actual: { beforePrepare, all: events },
      expected: {
        beforePrepare: ['server.start'],
        all: [
          {
            event: 'server.start',
            fields: { operation: 'server.start', port: 0 },
          },
          {
            event: 'server.ready',
            fields: { operation: 'server.ready', durationMs: 7250 },
          },
        ],
      },
    });
  });

  test('a failed Next prepare rejects and never opens the gate', async () => {
    const { reached, preparing, started, listening, get, close } =
      startProduction();
    await listening();
    preparing.reject(new Error('prepare failed'));
    const refusal = await started.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    const page = (await get('/')).status;
    await close();
    assert({
      given: "Next's prepare() rejecting",
      should: 'reject with its error and keep answering 503 without Next',
      actual: { refusal, page, reachedNext: reached.length },
      expected: {
        refusal: 'prepare failed',
        page: 503,
        reachedNext: 0,
      },
    });
  });
});

describe('startProductionServer composition (ISSUE-193)', () => {
  test('routes nothing to Next while the runtime-role refusal is pending', async () => {
    const {
      reached,
      steps,
      refusing,
      preparing,
      started,
      listening,
      get,
      close,
    } = startProduction({ refusalPending: true });
    await listening();
    const whileRefusing = {
      page: (await get('/sign-in')).status,
      auth: (await get('/api/auth/get-session')).status,
      reachedNext: reached.length,
      steps: [...steps],
    };
    refusing.resolve();
    preparing.resolve();
    await started;
    const afterStart = (await get('/sign-in')).body;
    await close();
    assert({
      given: 'the port open and the ISSUE-39 role refusal not yet settled',
      should:
        'answer 503 without reaching Next, refuse before preparing Next, then serve through Next',
      actual: { whileRefusing, steps, afterStart },
      expected: {
        whileRefusing: {
          page: 503,
          auth: 503,
          reachedNext: 0,
          steps: ['refuseRole'],
        },
        steps: ['refuseRole', 'prepare'],
        afterStart: 'next',
      },
    });
  });

  test('a refused runtime role never prepares Next or opens the gate', async () => {
    const { reached, steps, refusing, started, listening, get, close } =
      startProduction({ refusalPending: true });
    await listening();
    refusing.reject(new Error('refused: schema-altering role'));
    const refusal = await started.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    const auth = (await get('/api/auth/get-session')).status;
    await close();
    assert({
      given: 'a DATABASE_URL role that can alter the schema',
      should:
        'reject with the refusal, never call prepare, and keep every route at 503 without Next',
      actual: { refusal, steps, auth, reachedNext: reached.length },
      expected: {
        refusal: 'refused: schema-altering role',
        steps: ['refuseRole'],
        auth: 503,
        reachedNext: 0,
      },
    });
  });
});

describe('startup gate request targets', () => {
  test('answers 503 to a target no URL parser accepts, and keeps serving', async () => {
    const { rawStatus, reached, preparing, started, listening, get, close } =
      startProduction();
    await listening();
    const statuses = [await rawStatus('//'), await rawStatus('http://[')];
    const live = (await get('/api/health/live')).status;
    preparing.resolve();
    await started;
    await close();
    assert({
      given:
        "request targets '//' and 'http://[' while start-up work is still running",
      should:
        'answer each 503 without reaching Next, and still answer liveness afterwards',
      actual: { statuses, live, reachedNext: reached.length },
      expected: { statuses: [503, 503], live: 200, reachedNext: 0 },
    });
  });
});
