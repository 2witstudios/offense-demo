import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { slotNaming, withStackPorts } from './slot-naming';

setupRitewayBun();

const redisNamespaceRule = /^[a-z][a-z0-9-]{0,62}$/;
const postgresIdentifierRule = /^[a-z_][a-z0-9_]{0,62}$/;

describe('slotNaming', () => {
  test('a hyphenated slug keeps kebab namespaces and snake database names', () => {
    const naming = slotNaming('widget-app');
    const longestId = 'a'.repeat(naming.maxIdLength);
    assert({
      given: 'the project slug widget-app and the longest allowed slot id',
      should:
        'name databases widget_app_wt_… and namespaces widget-app-wt-…, all within their limits',
      actual: {
        databaseBase: naming.databaseBase,
        database: naming.worktreeDatabasePrefix,
        namespace: naming.worktreeNamespacePrefix,
        longestDatabase: postgresIdentifierRule.test(
          `${naming.worktreeDatabasePrefix}${longestId}_test_run_0123abcd`,
        ),
        longestNamespace: redisNamespaceRule.test(
          `${naming.worktreeNamespacePrefix}${longestId}-e2e`,
        ),
      },
      expected: {
        databaseBase: 'widget_app',
        database: 'widget_app_wt_',
        namespace: 'widget-app-wt-',
        longestDatabase: true,
        longestNamespace: true,
      },
    });
  });

  test('refuses a slug too long to leave room for slot ids', () => {
    let message = 'no throw';
    try {
      slotNaming('an-exceptionally-long-project-slug');
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'a 34-character slug',
      should: 'refuse rather than derive unusable slot names',
      actual: message.startsWith(
        'Project slug "an-exceptionally-long-project-slug" is too long',
      ),
      expected: true,
    });
  });
});

describe('withStackPorts', () => {
  const env = {
    DATABASE_URL: 'postgres://offense_demo:pw@localhost:15432/offense_demo',
    TEST_DATABASE_URL:
      'postgres://offense_demo:pw@localhost:15432/offense_demo_test',
    REDIS_URL: 'redis://localhost:6379',
    TEST_REDIS_URL: 'redis://localhost:6379/1',
    PORT: '3000',
  };

  test('moves the stack URLs to the configured host ports', () => {
    assert({
      given:
        'OFFENSE_DEMO_POSTGRES_PORT=25432 and OFFENSE_DEMO_REDIS_PORT=16379',
      should: 'rewrite only the Postgres and Redis URL ports',
      actual: withStackPorts(env, {
        OFFENSE_DEMO_POSTGRES_PORT: '25432',
        OFFENSE_DEMO_REDIS_PORT: '16379',
      }),
      expected: {
        DATABASE_URL: 'postgres://offense_demo:pw@localhost:25432/offense_demo',
        TEST_DATABASE_URL:
          'postgres://offense_demo:pw@localhost:25432/offense_demo_test',
        REDIS_URL: 'redis://localhost:16379',
        TEST_REDIS_URL: 'redis://localhost:16379/1',
        PORT: '3000',
      },
    });
  });

  test('leaves the URLs as written when no port is configured', () => {
    assert({
      given: 'no port variables',
      should: 'return the env unchanged',
      actual: withStackPorts(env, {}),
      expected: env,
    });
  });

  test('refuses a port that is not a port number', () => {
    let message = 'no throw';
    try {
      withStackPorts(env, { OFFENSE_DEMO_REDIS_PORT: 'six' });
    } catch (error) {
      message = (error as Error).message;
    }
    assert({
      given: 'OFFENSE_DEMO_REDIS_PORT=six',
      should: 'name the variable and the bad value',
      actual: message,
      expected:
        'OFFENSE_DEMO_REDIS_PORT must be a port number (1-65535), got "six"',
    });
  });
});
