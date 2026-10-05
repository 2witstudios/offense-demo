import type { ServerWebSocket } from 'bun';
import type { Logger } from '@offense-demo/logger';
import { closeFor, evaluateFirstMessage } from './handlers/hello';

/** ADR 0031 §11.5: the first message must arrive within 5s or the socket closes 4001. */
export const HELLO_TIMEOUT_MS = 5_000;

export type SocketData = {
  helloTimer?: ReturnType<typeof setTimeout> | undefined;
};
export type SocketTimers = {
  readonly setTimeout: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
};
const systemTimers: SocketTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const clearHelloTimer = (
  ws: ServerWebSocket<SocketData>,
  timers: SocketTimers,
) => {
  if (ws.data.helloTimer === undefined) return;
  timers.clearTimeout(ws.data.helloTimer);
  ws.data.helloTimer = undefined;
};

const logRejection = (
  logger: Logger,
  cause: 'hello_timeout' | 'message_rejected',
  code: number,
  reason: string,
) =>
  logger.log(
    'realtime.connection.rejected',
    { closeCode: code, closeReason: reason, cause },
    'Connection rejected',
  );

/**
 * Wires ADR 0031's socket lifecycle: arm the hello deadline on open, decide
 * every first frame (RT-2.4b onward will hand this a real success path),
 * and always clear the timer on close. No subscribe registry, drain loop or
 * ring exists yet (RT-2.3b, RT-2.3c, RT-2.5a); nothing here assumes one.
 */
export function createWebSocketHandlers({
  logger,
  timers = systemTimers,
}: {
  readonly logger: Logger;
  readonly timers?: SocketTimers;
}) {
  return {
    open(ws: ServerWebSocket<SocketData>) {
      ws.data.helloTimer = timers.setTimeout(() => {
        ws.data.helloTimer = undefined;
        const { code, reason } = closeFor('auth_failed');
        logRejection(logger, 'hello_timeout', code, reason);
        ws.close(code, reason);
      }, HELLO_TIMEOUT_MS);
    },
    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      clearHelloTimer(ws, timers);
      const raw =
        typeof message === 'string' ? message : message.toString('utf8');
      const outcome = evaluateFirstMessage(raw);
      logRejection(logger, 'message_rejected', outcome.code, outcome.reason);
      ws.close(outcome.code, outcome.reason);
    },
    close(ws: ServerWebSocket<SocketData>) {
      clearHelloTimer(ws, timers);
    },
  };
}
