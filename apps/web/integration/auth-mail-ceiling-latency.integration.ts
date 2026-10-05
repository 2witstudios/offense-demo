import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createCeilingFlows,
  saturateGlobalMinute,
} from './auth-ceiling-helpers';
import { elapse, recipientBucket } from './auth-rate-limit-helpers';
import { createTestApp } from './fixtures';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-185: with the global sign-up ceiling saturated, how long the answer
 * takes must not tell a caller whether an address has an account. The
 * dropped sign-up and the real sign-in send are both finished after the
 * answer, so each answer waits on the same work: the gate's buckets, the
 * suppression check, the token write and the ceiling spend.
 *
 * The provider is the suite's mailbox seam given a round trip
 * (`PROVIDER_LATENCY_MS`), because the real Resend call is the work that
 * separates the two paths when an answer waits on it.
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

/**
 * A stand-in for one Resend round trip, and smaller than a real one, so a
 * path that waits on delivery is slower by at least this much.
 */
const PROVIDER_LATENCY_MS = 150;

/** Sample pairs per path; see `KS_CRITICAL` for why this many. */
const PAIRS = 30;

/**
 * Two-sample Kolmogorov–Smirnov critical value at α = 0.001 for PAIRS
 * samples a side: c(α) · √((n + m) / nm), c(0.001) = 1.949. Samples from
 * one distribution exceed it one run in a thousand, while a path slower by
 * PROVIDER_LATENCY_MS (far above the tens-of-milliseconds spread of these
 * requests) separates the samples completely (D = 1).
 */
const KS_CRITICAL = 1.949 * Math.sqrt((PAIRS + PAIRS) / (PAIRS * PAIRS));

/** The largest gap between two samples' empirical distribution functions. */
const ksStatistic = (left: number[], right: number[]) => {
  const below = (sample: number[], at: number) =>
    sample.filter((value) => value <= at).length / sample.length;
  return Math.max(
    ...[...left, ...right].map((at) =>
      Math.abs(below(left, at) - below(right, at)),
    ),
  );
};

const median = (sample: number[]) => {
  const sorted = [...sample].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

/**
 * The real minute ceiling saturated by real requests, then held open for
 * the whole test so no sample lands in a fresh window.
 */
const saturate = () =>
  saturateGlobalMinute({ testApp, magicLink, fresh, settled });

/** An existing account's own recipient windows elapsed (3/minute, 10/hour, 20/day). */
const recipientRoom = (email: string) =>
  elapse(
    testApp,
    ...[60, 3_600, 86_400].map((window) =>
      recipientBucket(testApp, 'magic-link', email, window),
    ),
  );

describe('ISSUE-185 a saturated sign-up ceiling answers in the same time for any address', () => {
  test('the answer to an existing account does not wait on its delivery', async () => {
    await elapseGlobalMinute();
    const existing = (await accounts.signUp()).email;
    await saturate();
    const release = mailbox.hold();
    const before = mailbox.mails.length;
    const outcome = await Promise.race([
      magicLink(existing).then((response) => response.status),
      mailbox.nextArrival().then(
        () =>
          // The request had its turn after the provider was reached.
          new Promise<string>((resolve) =>
            setImmediate(() => resolve('waiting on delivery')),
          ),
      ),
    ]);
    const mailedBeforeRelease = mailbox.mails.length - before;
    release();
    await settled();
    assert({
      given:
        'the real minute ceiling saturated and a provider that has not answered',
      should:
        'answer the existing account 200 before its mail is delivered, then deliver it',
      actual: {
        outcome,
        mailedBeforeRelease,
        mailed: mailbox.mails
          .slice(before)
          .filter((mail) => mail.to === existing).length,
      },
      expected: { outcome: 200, mailedBeforeRelease: 0, mailed: 1 },
    });
  });

  test('response times for unknown addresses and existing accounts are not distinguishable', async () => {
    await elapseGlobalMinute();
    const existing = [
      (await accounts.signUp()).email,
      (await accounts.signUp()).email,
      (await accounts.signUp()).email,
    ];
    await saturate();
    mailbox.setLatency(PROVIDER_LATENCY_MS);
    const unknownMs: number[] = [];
    const existingMs: number[] = [];
    const unknownAddresses: string[] = [];
    const statuses = new Set<number>();
    const before = mailbox.mails.length;
    /** One timed request, after the previous one's post-answer work. */
    const sample = async (email: string, into: number[]) => {
      await settled();
      const started = performance.now();
      const response = await magicLink(email);
      into.push(performance.now() - started);
      statuses.add(response.status);
    };
    for (let pair = 0; pair < PAIRS; pair += 1) {
      const email = existing[pair % existing.length] as string;
      const unknown = fresh();
      unknownAddresses.push(unknown);
      // Both paths get the same untimed preparation, so neither sample
      // follows more work of the test's own than the other.
      await recipientRoom(email);
      await recipientRoom(unknown);
      const runs = [
        () => sample(unknown, unknownMs),
        () => sample(email, existingMs),
      ];
      // ABBA order: a drift in machine load weighs on both paths alike.
      for (const run of pair % 2 === 0 ? runs : runs.reverse()) await run();
    }
    await settled();
    mailbox.setLatency(0);
    const mailed = mailbox.mails.slice(before).map((mail) => mail.to);
    const statistic = ksStatistic(unknownMs, existingMs);

    assert({
      given: `the real minute ceiling saturated and held, a provider taking ${PROVIDER_LATENCY_MS} ms, and ${PAIRS} interleaved requests each for new addresses and existing accounts`,
      should:
        'answer every request 200, mail every existing account and no new address',
      actual: {
        statuses: [...statuses],
        existingMailed: mailed.filter((to) => existing.includes(to)).length,
        unknownMailed: mailed.filter((to) => unknownAddresses.includes(to))
          .length,
      },
      expected: { statuses: [200], existingMailed: PAIRS, unknownMailed: 0 },
    });
    assert({
      given: `the same samples (medians: new ${median(unknownMs).toFixed(1)} ms, existing ${median(existingMs).toFixed(1)} ms; distance ${statistic.toFixed(3)})`,
      should: `keep the Kolmogorov–Smirnov distance under the α = 0.001 critical value ${KS_CRITICAL.toFixed(3)}`,
      actual: statistic < KS_CRITICAL,
      expected: true,
    });
  });

  test('closing the app finishes the work answered before it, then closes the pools', async () => {
    await elapseGlobalMinute();
    const existing = (await accounts.signUp()).email;
    // An app of its own, so this test can close it: same databases, its own
    // Redis namespace and mailbox.
    const closing = createTestApp();
    const request = (email: string) =>
      closing.routes.auth.POST(
        closing.jsonPost('/api/auth/sign-in/magic-link', { email }),
      );
    await saturateGlobalMinute({
      testApp: closing,
      magicLink: request,
      fresh: closing.freshEmail,
      settled: () => closing.app.auth().settled(),
    });
    const release = closing.mailbox.hold();
    const arrived = closing.mailbox.nextArrival();
    const { result, events } = await closing.withLoggedEvents(async () => {
      const status = (await request(existing)).status;
      const closed = closing.app.close();
      // A close that did not wait would end before the mail reaches the
      // provider; either way the provider is released only after one.
      await Promise.race([arrived, closed]);
      release();
      await closed;
      return status;
    });
    assert({
      given:
        'a saturated app answering an existing account, then closed while the provider still holds its mail',
      should:
        'deliver the mail and record its receipt before the pools close, with no failure logged',
      actual: {
        status: result,
        mailed: closing.mailbox.mails.filter((mail) => mail.to === existing)
          .length,
        failures: events.filter(
          (event) =>
            event === 'request.unhandled' ||
            event === 'auth.mail.receipt_failed' ||
            event === 'auth.mail.failed',
        ),
        sent: events.includes('auth.mail.sent'),
      },
      expected: { status: 200, mailed: 1, failures: [], sent: true },
    });
  });
});
