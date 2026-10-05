import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createCeilingFlows,
  saturateGlobalMinute,
} from './auth-ceiling-helpers';
import { statuses } from './auth-rate-limit-helpers';
import {
  AFTER_RESPONSE_MAX_QUEUED,
  AFTER_RESPONSE_MAX_RUNNING,
} from '../src/features/auth/after-response';
import { createTestApp } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-185 (DEC-73): a saturated request hands its account lookup and its
 * send or drop to work that runs after the answer. That work is bounded:
 * at most AFTER_RESPONSE_MAX_RUNNING hold a slot and
 * AFTER_RESPONSE_MAX_QUEUED wait, and anything past that is shed before the
 * lookup, logged and counted, whatever the address. A flood can therefore
 * not grow the backlog with its request rate.
 *
 * Filling the production pool takes 577 held real sends, so the shedding
 * test runs the same code with the bounds narrowed (`NARROW_LIMITS`); the
 * other tests use the production bounds.
 */
requireTestServices(process.env);
setupRitewayBun();

const {
  accounts,
  testApp,
  mailbox,
  fresh,
  magicLink,
  elapseGlobalMinute,
  settled,
} = createCeilingFlows();

const BOUND = AFTER_RESPONSE_MAX_RUNNING + AFTER_RESPONSE_MAX_QUEUED;

const NARROW_LIMITS = { maxRunning: 4, maxQueued: 64, dbSteps: 4 };
const NARROW_BOUND = NARROW_LIMITS.maxRunning + NARROW_LIMITS.maxQueued;
const narrow = createCeilingFlows(createTestApp({}, NARROW_LIMITS));

/**
 * Runs `work` for every item over `connections` concurrent callers, the
 * way a client holding that many connections would, while sampling the
 * handed-off work on every event-loop turn. Returns the answers and the
 * largest backlog seen.
 */
const flood = async <T>(
  items: readonly T[],
  connections: number,
  work: (item: T) => Promise<Response>,
  pendingWork = () => testApp.app.auth().pendingWork(),
) => {
  let peak = 0;
  let sampling = true;
  const sample = () => {
    peak = Math.max(peak, pendingWork());
    if (sampling) setImmediate(sample);
  };
  sample();
  const responses: Response[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: connections }, async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        responses.push(await work(item));
        peak = Math.max(peak, pendingWork());
      }
    }),
  );
  sampling = false;
  return { responses, peak };
};

/** One app's real minute ceiling saturated with fresh addresses and held open. */
const saturate = (
  flows: Parameters<typeof saturateGlobalMinute>[0] = {
    magicLink,
    fresh,
    settled,
    testApp,
  },
) => saturateGlobalMinute(flows);

/** Heap in use after a full collection, in megabytes. */
const heapMb = () => {
  Bun.gc(true);
  return process.memoryUsage().heapUsed / 2 ** 20;
};

const shedCount = (events: readonly string[]) =>
  events.filter((event) => event === 'auth.mail.shed').length;

describe('ISSUE-185 work handed off past a saturated answer is bounded', () => {
  test('a flood of existing accounts over 20 connections never holds more than the bound, and sheds the rest (narrowed bounds)', async () => {
    await narrow.elapseGlobalMinute();
    // One at a time: a sign-up finds its link by mailbox position.
    const existing: string[] = [];
    for (let index = 0; index < 100; index += 1)
      existing.push((await narrow.accounts.signUp()).email);
    await saturate(narrow);
    const release = narrow.mailbox.hold();
    const before = narrow.mailbox.mails.length;
    const shedBefore = narrow.testApp.app.metrics.snapshot().authMailShedTotal;
    // Two requests per account stay inside its 3-a-minute recipient window
    // (the sign-up spent the first), so every one is admitted.
    const narrowPending = () => narrow.testApp.app.auth().pendingWork();
    const { result, events } = await narrow.testApp.withLoggedEvents(() =>
      flood(
        existing.flatMap((email) => [email, email]),
        20,
        (email) => narrow.magicLink(email),
        narrowPending,
      ),
    );
    const heldBacklog = narrowPending();
    release();
    await narrow.settled();
    const mailed = narrow.mailbox.mails.length - before;

    assert({
      given: `the real minute ceiling saturated, the provider not answering, and 200 requests for 100 existing accounts over 20 connections`,
      should: `answer all 200 with 200, hold at most ${NARROW_BOUND} tasks, shed and count every other before its lookup, and mail exactly the held ones once the provider answers`,
      actual: {
        statuses: statuses(result.responses),
        withinBound: result.peak <= NARROW_BOUND,
        heldBacklog,
        shedLogged: shedCount(events),
        shedCounted:
          narrow.testApp.app.metrics.snapshot().authMailShedTotal - shedBefore,
        mailed,
      },
      expected: {
        statuses: { 200: 200 },
        withinBound: true,
        heldBacklog: NARROW_BOUND,
        shedLogged: 200 - NARROW_BOUND,
        shedCounted: 200 - NARROW_BOUND,
        mailed: NARROW_BOUND,
      },
    });
  }, 300_000);

  test('a flood of unknown addresses over 1,000 connections never holds more than the bound, and memory stays flat', async () => {
    await elapseGlobalMinute();
    await saturate();
    const heapBefore = heapMb();
    const { responses, peak } = await flood(
      Array.from({ length: 1_200 }, () => fresh()),
      1_000,
      (email) => magicLink(email),
    );
    await settled();
    const heapAfter = heapMb();

    assert({
      given: `the real minute ceiling saturated and 1,200 requests for new addresses over 1,000 connections (peak backlog ${peak}, heap ${heapBefore.toFixed(0)} → ${heapAfter.toFixed(0)} MB)`,
      should: `answer every one 200, never hold more than ${BOUND} tasks, and return the heap to within 64 MB of where it started`,
      actual: {
        statuses: statuses(responses),
        withinBound: peak <= BOUND,
        heapFlat: heapAfter - heapBefore < 64,
      },
      expected: {
        statuses: { 200: 1_200 },
        withinBound: true,
        heapFlat: true,
      },
    });
  }, 300_000);

  test('a shutdown deadline that cuts handed-off work off logs how much, with no address (ISSUE-214)', async () => {
    await elapseGlobalMinute();
    const existing = (await accounts.signUp()).email;
    await saturate();
    const release = mailbox.hold();
    const arrived = mailbox.nextArrival();
    const { result, records } = await testApp.recordLogs(async () => {
      const status = (await magicLink(existing)).status;
      await arrived;
      testApp.app.reportUnfinishedWork();
      return status;
    });
    release();
    await settled();
    const quiet = await testApp.recordLogs(async () =>
      testApp.app.reportUnfinishedWork(),
    );
    assert({
      given:
        'a saturated sign-in whose send the provider still holds when the shutdown deadline is reached, then again once it has finished',
      should:
        'log auth.mail.abandoned with the unfinished count and nothing else, then log nothing',
      actual: {
        status: result,
        abandoned: records
          .filter((record) => record.event === 'auth.mail.abandoned')
          .map(({ operation, pending, msg }) => ({ operation, pending, msg })),
        afterwards: quiet.records.length,
      },
      expected: {
        status: 200,
        abandoned: [
          {
            operation: 'server.shutdown',
            pending: 1,
            msg: 'Auth work after the answer was cut off by the shutdown deadline',
          },
        ],
        afterwards: 0,
      },
    });
  }, 300_000);
});
