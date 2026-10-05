import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock } from '@offense-demo/clock';
import { createRetentionSweep, retentionTargets } from './retention-sweep';
import { createRecordingLogger } from './test-loggers.test-support';

setupRitewayBun();

// ISSUE-8 AC5 / AUTH-7.5: the production target list's shape and windows,
// split from retention-sweep.test.ts (the sweep's own run behaviour) to
// stay under the file's line budget.
const now = '2026-09-20T12:00:00.000Z';

const recorder = () => {
  const { recorded: logged, logger } = createRecordingLogger();
  return { logged, logger };
};

describe('retention targets', () => {
  const purges = () => {
    const calls: Record<string, Array<{ before: string; limit: number }>> = {};
    const record =
      (name: string) => async (input: { before: string; limit: number }) => {
        (calls[name] ??= []).push(input);
        return 0;
      };
    const sweeps: number[] = [];
    return {
      calls,
      sweeps,
      database: {
        purgeExpiredVerifications: record('verification'),
        purgeExpiredOutboxEvents: record('outbox'),
        purgeExpiredEmailDeliveryEvents: record('email_delivery_event'),
        purgeExpiredEmailDeliveries: record('email_delivery'),
        purgeExpiredSessions: record('session'),
      },
      redis: {
        sweepOnlinePresence: async (limit: number) => {
          sweeps.push(limit);
          return 0;
        },
      },
    };
  };

  test('prunes each store with its own retention window and batch bounds', async () => {
    const { calls, sweeps, database, redis } = purges();
    const targets = retentionTargets({ database, redis });
    const { logger } = recorder();
    await createRetentionSweep({
      targets,
      clock: fixedClock(now),
      logger,
    }).run();
    assert({
      given: 'the production targets and a clock at 2026-09-20T12:00Z',
      should:
        'purge verification, session and outbox rows past 24 hours, email rows past 30 days, and sweep the Redis online set, each in its own bounded batches',
      actual: {
        targets: targets.map(({ name, batchSize, maxBatches }) => ({
          name,
          batchSize,
          maxBatches,
        })),
        calls,
        sweeps,
      },
      expected: {
        targets: [
          { name: 'retention.verification', batchSize: 500, maxBatches: 20 },
          { name: 'retention.outbox', batchSize: 200, maxBatches: 200 },
          { name: 'retention.session', batchSize: 500, maxBatches: 20 },
          {
            name: 'retention.email_delivery_event',
            batchSize: 500,
            maxBatches: 20,
          },
          { name: 'retention.email_delivery', batchSize: 500, maxBatches: 20 },
          {
            name: 'retention.presence_online',
            batchSize: 1000,
            maxBatches: 50,
          },
        ],
        calls: {
          verification: [{ before: '2026-09-19T12:00:00.000Z', limit: 500 }],
          session: [{ before: '2026-09-19T12:00:00.000Z', limit: 500 }],
          outbox: [{ before: '2026-09-19T12:00:00.000Z', limit: 200 }],
          email_delivery_event: [
            { before: '2026-08-21T12:00:00.000Z', limit: 500 },
          ],
          email_delivery: [{ before: '2026-08-21T12:00:00.000Z', limit: 500 }],
        },
        sweeps: [1000],
      },
    });
  });

  test('an unusable clock fails every time-windowed target instead of throwing, and the Redis sweep still runs', async () => {
    const { calls, sweeps, database, redis } = purges();
    const { logged, logger } = recorder();
    const results = await createRetentionSweep({
      targets: retentionTargets({ database, redis }),
      clock: { now: () => 'not a timestamp' },
      logger,
    }).run();
    assert({
      given: 'a clock that returns an unparsable timestamp',
      should:
        'report ok:false for the five database targets with no purge issued, and sweep the Redis online set by its own clock',
      actual: {
        ok: results.map(({ operation, ok }) => [operation, ok]),
        calls,
        sweeps,
        failed: logged.filter(({ event }) => event === 'retention.sweep.failed')
          .length,
      },
      expected: {
        ok: [
          ['retention.verification', false],
          ['retention.outbox', false],
          ['retention.session', false],
          ['retention.email_delivery_event', false],
          ['retention.email_delivery', false],
          ['retention.presence_online', true],
        ],
        calls: {},
        sweeps: [1000],
        failed: 5,
      },
    });
  });
});
