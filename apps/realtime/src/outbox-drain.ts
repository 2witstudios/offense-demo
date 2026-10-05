import type { OutboxPosition, OutboxRow } from '@offense-demo/db';
import type { Logger } from '@offense-demo/logger';

/**
 * Hands drained rows to whatever consumes them; RT-2.3c wires the real
 * fan-out to subscribed sockets. This leaf stops at the seam.
 *
 * Synchronous by contract (ADR 0032 §4): the drain loop calls `sink` and
 * advances its cursor in the same tick, with no `await` between them, so a
 * subscribe racing the drain (RT-2.3c's ring) never observes a cursor that
 * has moved past rows the sink has not yet published. A sink with its own
 * async work (a socket write, a ring append) queues that work after this
 * synchronous hand-off — fire-and-forget from the loop's point of view —
 * rather than returning a pending promise here.
 */
export type OutboxRowsSink = (rows: readonly OutboxRow[]) => void;

const MAX_DRAIN_LIMIT = 500;

export type OutboxDrainDeps = {
  /** `createDatabase()`'s bound drain read (RT-2.3b, `@offense-demo/db`'s `outboxOperations`). */
  readonly drainOutbox: (
    cursor: OutboxPosition,
    limit?: number,
  ) => Promise<readonly OutboxRow[]>;
  readonly sink: OutboxRowsSink;
  readonly initialCursor: OutboxPosition;
  readonly logger: Logger;
  /** Test seam only: counts range queries without altering behavior. */
  readonly onQuery?: (() => void) | undefined;
};

export type OutboxDrainLoop = {
  /** A NOTIFY wakeup: sets the dirty flag and runs a pass if idle (ADR 0032 §3). */
  readonly wake: () => void;
  /** The 1 s poll wakeup: the correctness mechanism, never a fallback. */
  readonly poll: () => void;
  readonly cursor: () => OutboxPosition;
  /**
   * Stops accepting new wakeups and resolves once any in-flight pass has
   * ended, so a caller can safely close the database pool right after:
   * without this, a pass already mid-flight would keep calling
   * `drainOutbox` after shutdown started, against a pool that may already
   * be closing.
   */
  readonly stop: () => Promise<void>;
};

/**
 * One coalesced drain loop, never concurrent with itself (ADR 0032 §3): a
 * wakeup (NOTIFY or the 1 s poll) clears the dirty flag before each pass,
 * reads ordered ranges of up to 500 rows until a range comes back short,
 * and fans each range out to the sink before moving the cursor. A wakeup
 * that arrives while a pass is running only sets the flag again, so the
 * loop reruns once as soon as the current pass ends instead of running one
 * query per event.
 *
 * A range's sink call and cursor advance happen in the same synchronous
 * tick (ADR 0032 §4), so a synchronously throwing sink leaves the cursor
 * unmoved past that range. A failed range read or a throwing sink is
 * caught around the pass (never inside the tick), logged as a registered
 * event, and ends this pass without re-throwing. The loop itself never
 * dies; the next wakeup (a fresh NOTIFY or the next poll tick, ADR 0032
 * §3's correctness mechanism, never a fallback) starts a new pass and
 * retries from that same cursor.
 */
export function createOutboxDrainLoop({
  drainOutbox,
  sink,
  initialCursor,
  logger,
  onQuery,
}: OutboxDrainDeps): OutboxDrainLoop {
  let cursor = initialCursor;
  let dirty = false;
  let running = false;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();

  async function runPass(): Promise<void> {
    if (running) return;
    running = true;
    try {
      do {
        dirty = false;
        let rows: readonly OutboxRow[];
        try {
          do {
            if (stopped) return;
            onQuery?.();
            rows = await drainOutbox(cursor, MAX_DRAIN_LIMIT);
            if (rows.length > 0) {
              // No `await` between these two lines (ADR 0032 §4): a
              // synchronous throw from `sink` skips the cursor assignment,
              // and nothing else can run in between to observe a moved
              // cursor for rows the sink has not seen.
              sink(rows);
              const last = rows[rows.length - 1];
              if (last) cursor = { txid: last.txid, seq: last.seq };
            }
          } while (rows.length === MAX_DRAIN_LIMIT);
        } catch {
          // The failing operation (the range read or the sink) is not
          // distinguished in the log: AGENTS.md forbids logging a raw
          // exception, and either way the response is identical — stop
          // this pass with the cursor unmoved past the failure, and let
          // the next wakeup retry.
          logger.log(
            'realtime.outbox.drain_failed',
            { operation: 'drainOutbox' },
            'Outbox drain pass failed; the next wakeup retries',
          );
          return;
        }
      } while (dirty && !stopped);
    } finally {
      running = false;
    }
  }

  function trigger(): void {
    if (stopped) return;
    dirty = true;
    if (!running) current = runPass();
  }

  return {
    wake: trigger,
    poll: trigger,
    cursor: () => cursor,
    async stop() {
      stopped = true;
      await current;
    },
  };
}

export type IntervalTimers = {
  readonly setInterval: (
    callback: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  readonly clearInterval: (handle: ReturnType<typeof setInterval>) => void;
};
const systemIntervalTimers: IntervalTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/** The correctness mechanism's period (ADR 0032 §3): never a fallback, never disabled. */
const DRAIN_POLL_INTERVAL_MS = 1_000;

type OutboxListenSubscription = {
  readonly unlisten: () => Promise<void>;
};

export type OutboxDrainDatabase = {
  readonly listenOutbox: (handlers: {
    readonly onNotify: (position: string) => void;
    readonly onListen: () => void;
  }) => Promise<OutboxListenSubscription>;
  readonly readOutboxHighWaterMark: () => Promise<OutboxPosition>;
  readonly drainOutbox: (
    cursor: OutboxPosition,
    limit?: number,
  ) => Promise<readonly OutboxRow[]>;
};

export type OutboxDrainControl = {
  readonly cursor: () => OutboxPosition;
  readonly stop: () => Promise<void>;
};

/**
 * Instance startup order (ADR 0032 §2): `LISTEN outbox` first, awaited to
 * its PostgreSQL acknowledgement; only then the high-water mark read seeds
 * the drain loop's cursor. A notification or reconnect (`onListen`, fired
 * again by Bun SQL after every reconnect) that lands before the loop exists
 * is buffered as a pending wake rather than lost, then replayed once the
 * loop is ready. The caller accepts sockets only after this resolves.
 */
export async function startOutboxDrain({
  database,
  sink,
  logger,
  pollIntervalMs = DRAIN_POLL_INTERVAL_MS,
  timers = systemIntervalTimers,
  onQuery,
  onListenWake,
}: {
  readonly database: OutboxDrainDatabase;
  readonly sink: OutboxRowsSink;
  readonly logger: Logger;
  /** Test seam only; production never overrides the ADR-fixed period. */
  readonly pollIntervalMs?: number;
  readonly timers?: IntervalTimers;
  readonly onQuery?: () => void;
  /**
   * Test seam only: fires whenever Bun SQL's `onListen` runs (the initial
   * subscribe and every reconnect), before the wake it triggers. Lets a
   * test observe that a reconnect drove this instance's own subscription,
   * independent of database content or any other listener's traffic on
   * the shared `outbox` channel (RT-2.3b-f1 criterion 2).
   */
  readonly onListenWake?: () => void;
}): Promise<OutboxDrainControl> {
  const state: { loop?: OutboxDrainLoop; pendingWake: boolean } = {
    pendingWake: false,
  };
  const wake = () => {
    if (state.loop) state.loop.wake();
    else state.pendingWake = true;
  };

  const subscription = await database.listenOutbox({
    onNotify: () => wake(),
    onListen: () => {
      onListenWake?.();
      wake();
    },
  });

  // From here on, any failure must still unlisten: otherwise the dedicated
  // LISTEN connection outlives this function, and neither `start.ts`'s
  // shutdown handler (never installed, since `serveRealtime` never
  // resolved) nor anything else ever closes it.
  try {
    const initialCursor = await database.readOutboxHighWaterMark();
    const loop = createOutboxDrainLoop({
      drainOutbox: database.drainOutbox,
      sink,
      initialCursor,
      logger,
      onQuery,
    });
    state.loop = loop;
    if (state.pendingWake) loop.wake();

    const interval = timers.setInterval(() => loop.poll(), pollIntervalMs);

    return {
      cursor: () => loop.cursor(),
      async stop() {
        timers.clearInterval(interval);
        await loop.stop();
        await subscription.unlisten();
      },
    };
  } catch (error) {
    await subscription.unlisten();
    throw error;
  }
}
