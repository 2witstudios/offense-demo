import {
  OUTBOX_ORIGIN,
  type OutboxPosition,
  type OutboxRow,
} from '@offense-demo/db';
import type { Logger } from '@offense-demo/logger';
import { createOutboxDrainLoop, type OutboxDrainLoop } from './outbox-drain';

export const flush = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

export const noopLogger: Logger = { log: () => {}, child: () => noopLogger };

export function recordingLogger(): {
  readonly logger: Logger;
  readonly events: string[];
} {
  const events: string[] = [];
  const logger: Logger = {
    log: (event) => {
      events.push(event);
    },
    child: () => logger,
  };
  return { logger, events };
}

export const fakeRow = (seq: bigint): OutboxRow => ({
  txid: '1',
  seq,
  topic: 'room:fake',
  kind: 'room.changed',
  version: 1,
  payload: { entityVersion: 1, kind: 'room.changed', ids: ['fake'] },
  createdAt: '2026-09-23T00:00:00.000Z',
});

/** A drain loop wired to a test's own `drainOutbox`, delivering into a captured array. */
export function buildTestLoop(
  drainOutbox: (
    cursor: OutboxPosition,
    limit?: number,
  ) => Promise<readonly OutboxRow[]>,
  logger: Logger = noopLogger,
): {
  readonly loop: OutboxDrainLoop;
  readonly delivered: (readonly OutboxRow[])[];
} {
  const delivered: (readonly OutboxRow[])[] = [];
  const loop = createOutboxDrainLoop({
    drainOutbox,
    sink: (rows) => {
      delivered.push(rows);
    },
    initialCursor: OUTBOX_ORIGIN,
    logger,
  });
  return { loop, delivered };
}

/** Runs `work`, asserting no `unhandledRejection` fired while it ran. */
export async function withUnhandledRejectionCheck<T>(
  work: () => Promise<T>,
): Promise<{ readonly result: T; readonly unhandled: unknown }> {
  let unhandled: unknown;
  const onUnhandled = (error: unknown) => {
    unhandled = error;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await work();
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}
