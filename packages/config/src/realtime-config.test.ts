import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readRealtimeConfig } from './index';

setupRitewayBun();

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:secret@localhost:5432/offense_demo',
  REDIS_URL: 'redis://localhost:6379',
};

describe('realtime configuration', () => {
  test('validates without a public app URL', () => {
    assert({
      given: 'a development environment with only the shared deployment fields',
      should: 'validate and default the Redis namespace to offense-demo',
      actual: readRealtimeConfig(env),
      expected: {
        NODE_ENV: 'development',
        DATABASE_URL: env.DATABASE_URL,
        REDIS_URL: env.REDIS_URL,
        REDIS_NAMESPACE: 'offense-demo',
        LOG_LEVEL: 'info',
        APP_VERSION: 'development',
        GIT_COMMIT: 'unknown',
      },
    });
  });

  test('a missing NODE_ENV refuses to start rather than skip production checks', () => {
    const withoutNodeEnv = { ...env };
    Reflect.deleteProperty(withoutNodeEnv, 'NODE_ENV');
    expect(() => readRealtimeConfig(withoutNodeEnv)).toThrow(
      'Invalid realtime configuration',
    );
  });

  test('production requires deployment identity and forbids local credentials', () => {
    expect(() =>
      readRealtimeConfig({ ...env, NODE_ENV: 'production' }),
    ).toThrow('Invalid realtime configuration');
    let message = '';
    try {
      readRealtimeConfig({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgres://offense_demo:local-development-only@localhost:15432/offense_demo',
        REDIS_URL: env.REDIS_URL,
        APP_VERSION: '1.0.0',
        GIT_COMMIT: 'abc1234',
      });
    } catch (error) {
      message = String(error);
    }
    assert({
      given: 'production configuration carrying local-development credentials',
      should: 'reject naming DATABASE_URL without echoing the credential',
      actual: {
        namesField: message.includes('DATABASE_URL'),
        echoesValue: message.includes('local-development-only'),
      },
      expected: { namesField: true, echoesValue: false },
    });
  });

  test('production succeeds with real deployment identity', () => {
    assert({
      given: 'a production environment with deployment identity set',
      should: 'validate',
      actual: readRealtimeConfig({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgres://user:production@db.example.com:5432/offense_demo',
        REDIS_URL: 'redis://cache.example.com:6379',
        APP_VERSION: '1.0.0',
        GIT_COMMIT: 'abc1234',
      }).APP_VERSION,
      expected: '1.0.0',
    });
  });
});
