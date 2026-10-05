import type { ServerWebSocket } from 'bun';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import type { Logger } from '@offense-demo/logger';
import {
  createWebSocketHandlers,
  HELLO_TIMEOUT_MS,
  type SocketData,
  type SocketTimers,
} from './socket';

setupRitewayBun();

const fakeLogger = (): { logger: Logger; calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const logger: Logger = {
    log: (...args) => {
      calls.push(args);
    },
    child: () => logger,
  };
  return { logger, calls };
};

const fakeSocket = (): {
  ws: ServerWebSocket<SocketData>;
  closes: { code: number; reason: string }[];
} => {
  const closes: { code: number; reason: string }[] = [];
  const ws = {
    data: {} as SocketData,
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
    },
  } as unknown as ServerWebSocket<SocketData>;
  return { ws, closes };
};

const fakeTimers = (): {
  timers: SocketTimers;
  scheduled: { callback: () => void; ms: number }[];
  cleared: unknown[];
} => {
  const scheduled: { callback: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  let nextHandle = 0;
  const timers: SocketTimers = {
    setTimeout: (callback, ms) => {
      scheduled.push({ callback, ms });
      nextHandle += 1;
      return nextHandle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
  };
  return { timers, scheduled, cleared };
};

describe('createWebSocketHandlers', () => {
  test('arms a 5s hello deadline on open', () => {
    const { timers, scheduled } = fakeTimers();
    const { logger } = fakeLogger();
    const { ws } = fakeSocket();
    const handlers = createWebSocketHandlers({ logger, timers });

    handlers.open(ws);

    assert({
      given: 'a newly opened socket',
      should: 'schedule the hello deadline at HELLO_TIMEOUT_MS',
      actual: scheduled.map((entry) => entry.ms),
      expected: [HELLO_TIMEOUT_MS],
    });
  });

  test('closes 4001 auth_failed and logs the rejection when the hello deadline fires', () => {
    const { timers, scheduled } = fakeTimers();
    const { logger, calls } = fakeLogger();
    const { ws, closes } = fakeSocket();
    const handlers = createWebSocketHandlers({ logger, timers });

    handlers.open(ws);
    scheduled[0]?.callback();

    assert({
      given: 'no message arriving before the hello deadline',
      should: 'close 4001 auth_failed and log it with cause hello_timeout',
      actual: {
        closes,
        loggedEvent: calls[0]?.[0],
        loggedFields: calls[0]?.[1],
      },
      expected: {
        closes: [{ code: 4001, reason: 'auth_failed' }],
        loggedEvent: 'realtime.connection.rejected',
        loggedFields: {
          closeCode: 4001,
          closeReason: 'auth_failed',
          cause: 'hello_timeout',
        },
      },
    });
  });

  test('clears the hello timer and closes per the parsed outcome on message', () => {
    const { timers, cleared } = fakeTimers();
    const { logger, calls } = fakeLogger();
    const { ws, closes } = fakeSocket();
    const handlers = createWebSocketHandlers({ logger, timers });

    handlers.open(ws);
    handlers.message(ws, 'not json');

    assert({
      given: 'a first message that fails to parse',
      should:
        'clear the hello timer, close 4003 and log the rejection with cause message_rejected',
      actual: {
        timerCleared: cleared.length,
        closes,
        loggedEvent: calls[0]?.[0],
        loggedFields: calls[0]?.[1],
      },
      expected: {
        timerCleared: 1,
        closes: [{ code: 4003, reason: 'protocol_unsupported' }],
        loggedEvent: 'realtime.connection.rejected',
        loggedFields: {
          closeCode: 4003,
          closeReason: 'protocol_unsupported',
          cause: 'message_rejected',
        },
      },
    });
  });

  test('clears the hello timer on close without a pending timer', () => {
    const { timers, cleared } = fakeTimers();
    const { logger } = fakeLogger();
    const { ws } = fakeSocket();
    const handlers = createWebSocketHandlers({ logger, timers });

    handlers.close(ws);

    assert({
      given: 'a socket that closes with no timer ever armed',
      should: 'never call clearTimeout',
      actual: cleared.length,
      expected: 0,
    });
  });
});
