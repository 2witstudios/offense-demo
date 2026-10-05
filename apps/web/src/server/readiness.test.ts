import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createRecordingLogger } from './test-loggers.test-support';
import { createReadinessHandler } from './readiness';

setupRitewayBun();

const probe = (healthy: boolean | (() => Promise<boolean>)) => ({
  health: typeof healthy === 'function' ? healthy : async () => healthy,
});

describe('createReadinessHandler (ISSUE-146: cold-start ordering)', () => {
  test('reports ready only once every dependency answers healthy', async () => {
    const { logger } = createRecordingLogger();
    const handler = createReadinessHandler({
      database: probe(true),
      redis: probe(true),
      isDraining: () => false,
      logger,
    });
    const response = await handler(new Request('http://x/api/health/ready'));
    assert({
      given: 'a healthy database and redis, not draining',
      should: 'answer 200 ready',
      actual: { status: response.status, body: await response.json() },
      expected: { status: 200, body: { status: 'ready' } },
    });
  });

  test('reports unavailable while a dependency is genuinely down — no persistent boot flag, a live check every call', async () => {
    const { logger } = createRecordingLogger();
    // Simulates the cold-start window: Redis is not reachable yet.
    let redisReady = false;
    const handler = createReadinessHandler({
      database: probe(true),
      redis: probe(() => Promise.resolve(redisReady)),
      isDraining: () => false,
      logger,
    });
    const duringColdStart = await handler(
      new Request('http://x/api/health/ready'),
    );
    redisReady = true;
    const afterRedisAnswers = await handler(
      new Request('http://x/api/health/ready'),
    );
    assert({
      given:
        'redis unhealthy, then healthy, on the same handler with no restart',
      should:
        'answer 503 unavailable during the outage and 200 ready the moment it recovers, proving readiness is a live check rather than a boot-time flag',
      actual: {
        duringColdStart: {
          status: duringColdStart.status,
          body: await duringColdStart.json(),
        },
        afterRedisAnswers: {
          status: afterRedisAnswers.status,
          body: await afterRedisAnswers.json(),
        },
      },
      expected: {
        duringColdStart: { status: 503, body: { status: 'unavailable' } },
        afterRedisAnswers: { status: 200, body: { status: 'ready' } },
      },
    });
  });

  test('reports unavailable while draining, even with healthy dependencies', async () => {
    const { logger } = createRecordingLogger();
    const handler = createReadinessHandler({
      database: probe(true),
      redis: probe(true),
      isDraining: () => true,
      logger,
    });
    const response = await handler(new Request('http://x/api/health/ready'));
    assert({
      given: 'healthy dependencies but a draining process',
      should: 'answer 503 unavailable',
      actual: response.status,
      expected: 503,
    });
  });
});
