import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_MAX_CONNECTIONS } from '@offense-demo/db';
import type { Logger } from '@offense-demo/logger';

/**
 * Handed-off tasks holding a slot at once. A holder spends almost all its
 * time waiting on the provider or on the database gate below, holding no
 * database connection itself, so the pool is sized by memory rather than
 * by the database: each holder is a few closures and strings, well under
 * 10 KB, so 512 stay under 5 MB. A flood fills it only by keeping 512
 * tasks in flight at once, which takes the rate measured in ADR 0025.
 */
export const AFTER_RESPONSE_MAX_RUNNING = 512;

/** Handed-off tasks waiting for a slot once all AFTER_RESPONSE_MAX_RUNNING are held. */
export const AFTER_RESPONSE_MAX_QUEUED = 64;

/**
 * Database steps (the account lookup, the suppression read and the one
 * write) that handed-off work runs at once: two-fifths of the pool, so the
 * rest stays with the requests being answered. The steps queue in arrival
 * order. Only a task holding a slot makes a step, one at a time, so the
 * gate's own queue never exceeds AFTER_RESPONSE_MAX_RUNNING.
 */
const AFTER_RESPONSE_DB_STEPS = Math.floor((DEFAULT_MAX_CONNECTIONS * 2) / 5);

/** Work an auth request hands off so that its answer never waits on it. */
type Work = () => Promise<void>;

/** Queues `work` to start once the current request has been answered. */
export type AfterResponse = (work: Work) => void;

export type AfterResponseLimits = {
  readonly maxRunning: number;
  readonly maxQueued: number;
  readonly dbSteps: number;
};

/**
 * Work that runs after the auth handler has produced its answer (ISSUE-185):
 * `around` runs one request and, once its handler has returned or thrown,
 * starts the work that request queued with `defer`. Work queued outside a
 * request (a direct `auth.api` call) starts at once, and the caller is still
 * not made to wait on it.
 *
 * A piece of work holds one of `maxRunning` slots until it ends;
 * `maxQueued` wait for a slot, and a piece arriving past both is shed
 * before it starts (so before any account lookup, whatever the address),
 * logged as `auth.mail.shed` with the backlog's size, and its unmailed
 * token expires unused (DEC-73). Its database steps go through `dbStep`,
 * at most `dbSteps` at once.
 *
 * `settled` resolves when every piece has finished, so a shutdown can wait
 * for it before the pools close. Work logs its own delivery failures. One
 * that still rejects (a database outage during a saturated request's
 * account lookup or token delete) is logged without its error, as the auth
 * handler logs one, never an unhandled rejection; its unmailed token
 * expires unused.
 */
export function createAfterResponse(
  logger: Logger,
  limits: AfterResponseLimits = {
    maxRunning: AFTER_RESPONSE_MAX_RUNNING,
    maxQueued: AFTER_RESPONSE_MAX_QUEUED,
    dbSteps: AFTER_RESPONSE_DB_STEPS,
  },
) {
  const queues = new AsyncLocalStorage<Work[]>();
  /** Set while a handed-off task runs, so `dbStep` gates only its steps. */
  const inTask = new AsyncLocalStorage<true>();
  const running = new Set<Promise<void>>();
  const waiting: Work[] = [];
  const pending = () => running.size + waiting.length;
  const run = (work: Work) => {
    const task: Promise<void> = inTask
      .run(true, () => Promise.resolve().then(work))
      .catch(() =>
        logger.log(
          'request.unhandled',
          { source: 'auth.after-response' },
          'Authentication work after the answer failed',
        ),
      )
      .finally(() => {
        running.delete(task);
        const next = waiting.shift();
        if (next) run(next);
      });
    running.add(task);
  };
  const start = (work: Work) => {
    if (running.size < limits.maxRunning) run(work);
    else if (waiting.length < limits.maxQueued) waiting.push(work);
    else
      logger.log(
        'auth.mail.shed',
        { operation: 'auth.after-response', pending: pending() },
        'Auth work after the answer was shed; its backlog is full',
      );
  };
  const defer: AfterResponse = (work) => {
    const queue = queues.getStore();
    if (queue) queue.push(work);
    else start(work);
  };
  const around = async <T>(request: () => Promise<T>): Promise<T> => {
    const queue: Work[] = [];
    try {
      return await queues.run(queue, request);
    } finally {
      for (const work of queue.splice(0)) start(work);
    }
  };
  let stepsRunning = 0;
  const stepWaiters: Array<() => void> = [];
  /**
   * Runs one database step of handed-off work behind the gate; outside
   * handed-off work (a request being answered) it runs at once.
   */
  const dbStep = async <T>(step: () => Promise<T>): Promise<T> => {
    if (!inTask.getStore()) return step();
    if (stepsRunning >= limits.dbSteps)
      await new Promise<void>((resolve) => stepWaiters.push(resolve));
    else stepsRunning += 1;
    try {
      return await step();
    } finally {
      const next = stepWaiters.shift();
      if (next) next();
      else stepsRunning -= 1;
    }
  };
  /** Database steps of handed-off work running or waiting for the gate. */
  const dbSteps = () => stepsRunning + stepWaiters.length;
  const settled = async () => {
    while (running.size > 0) await Promise.allSettled([...running]);
  };
  return { defer, around, settled, pending, dbStep, dbSteps };
}
