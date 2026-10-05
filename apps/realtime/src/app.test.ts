import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock } from '@offense-demo/clock';
import { createRealtimeApp } from './app';

setupRitewayBun();

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unit:unit@localhost:5432/unit',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_NAMESPACE: 'unit-a',
  LOG_LEVEL: 'silent',
};

const build = (overrides: Record<string, string> = {}) =>
  createRealtimeApp({
    env: { ...env, ...overrides },
    clock: fixedClock('2026-09-23T00:00:00.000Z'),
  });

/** An app whose database and Redis closes are counted, never real. */
const withCountedCloses = () => {
  const app = build();
  let closed = 0;
  const count = async () => {
    closed += 1;
  };
  Object.assign(app.database, { close: count });
  Object.assign(app.redis, { close: count });
  return { app, closes: () => closed };
};

describe('createRealtimeApp', () => {
  test('builds independent instances from their own environments', async () => {
    const first = build();
    const second = build({ REDIS_NAMESPACE: 'unit-b' });
    await first.close();
    const observed = {
      first: [first.config.REDIS_NAMESPACE, first.isDraining()],
      second: [second.config.REDIS_NAMESPACE, second.isDraining()],
    };
    await second.close();
    assert({
      given: 'two realtime apps in one process, one closed',
      should: 'keep config and drain state to each instance',
      actual: observed,
      expected: { first: ['unit-a', true], second: ['unit-b', false] },
    });
  });

  test('refuses an invalid environment naming fields, never values', () => {
    let message = '';
    try {
      build({ REDIS_URL: 'http://unit:SECRET@localhost:6379' });
    } catch (error) {
      message = String(error);
    }
    assert({
      given: 'an environment whose Redis URL fails validation',
      should: 'throw naming the field without echoing its value',
      actual: {
        names: message.includes('REDIS_URL'),
        leaks: message.includes('SECRET'),
      },
      expected: { names: true, leaks: false },
    });
  });

  test('drain starts shutdown without closing the pools', async () => {
    const { app, closes } = withCountedCloses();
    const before = app.isDraining();
    app.drain();
    assert({
      given: 'a running app told to drain',
      should: 'report draining from then on and leave both pools open',
      actual: { before, after: app.isDraining(), closed: closes() },
      expected: { before: false, after: true, closed: 0 },
    });
    await app.close();
  });

  test('closing drains and closes both pools exactly once', async () => {
    const { app, closes } = withCountedCloses();
    await app.close();
    assert({
      given: 'an app holding a database pool and a Redis client',
      should: 'flag draining and close every pool',
      actual: { draining: app.isDraining(), closed: closes() },
      expected: { draining: true, closed: 2 },
    });
  });
});
