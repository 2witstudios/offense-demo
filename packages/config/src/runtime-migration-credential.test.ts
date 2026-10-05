import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readRealtimeConfig, readServerConfig } from './index';

setupRitewayBun();

/** The message a rejected configuration throws, or `accepted`. */
const failureOf = (read: () => unknown) => {
  try {
    read();
    return 'accepted';
  } catch (error) {
    return String(error);
  }
};

const owner =
  'postgres://offense_demo_migrator:owner-secret@db.internal:5432/offense_demo';
const production = {
  NODE_ENV: 'production',
  DATABASE_URL:
    'postgres://offense_demo_web:web-secret@db.internal:5432/offense_demo',
  REDIS_URL: 'redis://cache.example.com:6379',
  PUBLIC_APP_URL: 'https://offense-demo.example.com',
  APP_VERSION: '1.0.0',
  GIT_COMMIT: 'abc1234',
};

describe('runtime configuration never holds the migration credential (ISSUE-102)', () => {
  test('production web and realtime refuse MIGRATION_DATABASE_URL in their environment', () => {
    const withOwner = { ...production, MIGRATION_DATABASE_URL: owner };
    assert({
      given:
        'a production web or realtime environment that also carries MIGRATION_DATABASE_URL',
      should:
        'refuse to start, naming the field and never the owner credential',
      actual: {
        web: failureOf(() => readServerConfig(withOwner)),
        realtime: failureOf(() => readRealtimeConfig(withOwner)),
      },
      expected: {
        web: 'Error: Invalid server configuration: MIGRATION_DATABASE_URL',
        realtime:
          'Error: Invalid realtime configuration: MIGRATION_DATABASE_URL',
      },
    });
  });

  test('production starts without it, and development may hold it', () => {
    assert({
      given:
        'production without MIGRATION_DATABASE_URL, and development with it',
      should: 'accept both, keeping the credential out of the parsed config',
      actual: {
        productionWeb: failureOf(() => readServerConfig(production)),
        productionRealtime: failureOf(() => readRealtimeConfig(production)),
        developmentKeys: Object.keys(
          readServerConfig({
            ...production,
            NODE_ENV: 'development',
            MIGRATION_DATABASE_URL: owner,
          }),
        ).includes('MIGRATION_DATABASE_URL'),
      },
      expected: {
        productionWeb: 'accepted',
        productionRealtime: 'accepted',
        developmentKeys: false,
      },
    });
  });
});
