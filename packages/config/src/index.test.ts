import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readBrowserConfig, readServerConfig } from './index';

setupRitewayBun();

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:secret@localhost:5432/offense_demo',
  REDIS_URL: 'redis://localhost:6379',
  PUBLIC_APP_URL: 'http://localhost:3000',
};

describe('configuration', () => {
  test('strips secrets from the browser allowlist', () => {
    assert({
      given: 'server environment variables',
      should: 'expose only the browser allowlist to the browser',
      actual: readBrowserConfig(env),
      expected: {
        PUBLIC_APP_URL: env.PUBLIC_APP_URL,
      },
    });
  });

  test('production fails closed and errors never include credentials', () => {
    expect(() => readServerConfig({ ...env, NODE_ENV: 'production' })).toThrow(
      'Invalid server configuration',
    );
    let message = '';
    try {
      readServerConfig({ ...env, DATABASE_URL: 'secret' });
    } catch (error) {
      message = String(error);
    }
    assert({
      given: 'a rejected environment containing a credential-like value',
      should: 'never echo the value',
      actual: message.includes('secret'),
      expected: false,
    });
  });

  test('development configuration validates explicit dependencies', () => {
    assert({
      given: 'a development environment without a namespace override',
      should: 'default the Redis namespace to offense-demo',
      actual: readServerConfig(env).REDIS_NAMESPACE,
      expected: 'offense-demo',
    });
  });

  test('a missing NODE_ENV refuses to start rather than skip production checks', () => {
    const withoutNodeEnv = { ...env };
    Reflect.deleteProperty(withoutNodeEnv, 'NODE_ENV');
    expect(() => readServerConfig(withoutNodeEnv)).toThrow(
      'Invalid server configuration',
    );
  });

  test('production succeeds without authentication variables before auth activates', () => {
    assert({
      given: 'a valid production environment without auth variables',
      should: 'keep baseline startup validation passing',
      actual: readServerConfig({
        NODE_ENV: 'production',
        DATABASE_URL:
          'postgres://user:production@db.example.com:5432/offense_demo',
        REDIS_URL: 'redis://cache.example.com:6379',
        PUBLIC_APP_URL: 'https://offense-demo.example.com',
        APP_VERSION: '1.0.0',
        GIT_COMMIT: 'abc1234',
      }).PUBLIC_APP_URL,
      expected: 'https://offense-demo.example.com',
    });
  });
});
// Authentication configuration has its own suite: auth-config.test.ts.
// OPS_PROBE_TOKEN (AUTH-7.7) has its own suite: ops-probe-token.test.ts.
