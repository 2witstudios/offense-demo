import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock } from '@offense-demo/clock';
import { silentLogger } from '../../server/test-loggers.test-support';
import { createAlertsHandler } from './alerts';

setupRitewayBun();

const TOKEN = 'a'.repeat(32);
const NOW = '2026-09-25T12:00:00.000Z';

const makeHandler = (
  values = new Map<string, string>(),
  local = { limiterUnavailableSince: (): string | null => null },
) =>
  createAlertsHandler({
    logger: silentLogger,
    redis: { get: async (key) => values.get(key) ?? null },
    local,
    clock: fixedClock(NOW),
    token: () => TOKEN,
  });

const authorizedRequest = () =>
  new Request('http://localhost/api/ops/alerts', {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

describe('GET /api/ops/alerts (AUTH-7.7)', () => {
  test('refuses a request without the probe bearer token', async () => {
    const response = await makeHandler()(
      new Request('http://localhost/api/ops/alerts'),
    );
    assert({
      given: 'a request with no Authorization header',
      should: 'answer 401',
      actual: response.status,
      expected: 401,
    });
  });

  test('reports no conditions for a healthy, freshly-swept snapshot', async () => {
    const values = new Map([['alert-retention-last-success', NOW]]);
    const response = await makeHandler(values)(authorizedRequest());
    const body = (await response.json()) as { conditions: unknown[] };
    assert({
      given: 'a healthy snapshot with a token-authorized request',
      should: 'answer 200 with no fired conditions',
      actual: { status: response.status, conditions: body.conditions },
      expected: { status: 200, conditions: [] },
    });
  });

  test('reports the cleanup_missed condition when the sweep has never succeeded', async () => {
    const response = await makeHandler()(authorizedRequest());
    const body = (await response.json()) as { conditions: { id: string }[] };
    assert({
      given: 'an all-absent snapshot (no sweep ever recorded)',
      should: 'fire exactly cleanup_missed',
      actual: body.conditions.map((c) => c.id),
      expected: ['cleanup_missed'],
    });
  });

  test('answers limiter_unavailable from the in-process marker while its Redis is unreachable (ISSUE-191)', async () => {
    const handler = createAlertsHandler({
      logger: silentLogger,
      redis: {
        get: async () => {
          throw new Error('redis down');
        },
      },
      local: { limiterUnavailableSince: () => '2026-09-25T11:57:00.000Z' },
      clock: fixedClock(NOW),
      token: () => TOKEN,
    });
    const response = await handler(authorizedRequest());
    const body = (await response.json()) as {
      conditions: { id: string }[];
      snapshot: { redisState: string };
    };
    assert({
      given:
        'every alert Redis read rejecting and the limiter unavailable in process for 3 minutes',
      should:
        'answer 200 with limiter_unavailable and the snapshot marked unreachable',
      actual: {
        status: response.status,
        conditions: body.conditions.map((c) => c.id),
        redisState: body.snapshot.redisState,
      },
      expected: {
        status: 200,
        conditions: ['limiter_unavailable'],
        redisState: 'unreachable',
      },
    });
  });
});
