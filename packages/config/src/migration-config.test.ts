import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readMigrationConfig } from './index';

setupRitewayBun();

const owner =
  'postgres://offense_demo_owner:owner-secret@db.internal:5432/offense_demo';
const runtime =
  'postgres://offense_demo_web:web-secret@db.internal:5432/offense_demo';
const failureOf = (env: Record<string, string | undefined>) => {
  try {
    readMigrationConfig(env);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

describe('readMigrationConfig', () => {
  test('migrates with the owner credential in production', () => {
    assert({
      given:
        'production with MIGRATION_DATABASE_URL and a offense_demo_web DATABASE_URL',
      should: 'migrate through the migration credential, never the runtime one',
      actual: readMigrationConfig({
        NODE_ENV: 'production',
        MIGRATION_DATABASE_URL: owner,
        DATABASE_URL: runtime,
      }),
      expected: { databaseUrl: owner },
    });
  });

  test('refuses to migrate in production without a distinct migration credential', () => {
    assert({
      given:
        'production without MIGRATION_DATABASE_URL, with the runtime role reused, and with local credentials',
      should: 'refuse, naming fields and never their values',
      actual: [
        failureOf({ NODE_ENV: 'production', DATABASE_URL: runtime }),
        failureOf({
          NODE_ENV: 'production',
          MIGRATION_DATABASE_URL: runtime.replace('web-secret', 'other'),
          DATABASE_URL: runtime,
        }),
        failureOf({
          NODE_ENV: 'production',
          MIGRATION_DATABASE_URL:
            'postgres://offense_demo:local-development-only@localhost:5432/offense_demo',
          DATABASE_URL: runtime,
        }),
      ],
      expected: [
        'Invalid migration configuration: MIGRATION_DATABASE_URL',
        'Invalid migration configuration: MIGRATION_DATABASE_URL (must name a different role than DATABASE_URL)',
        'Invalid migration configuration: MIGRATION_DATABASE_URL (production forbids local development credentials)',
      ],
    });
  });

  test('migrates local and test databases through DATABASE_URL', () => {
    const local =
      'postgres://offense_demo:local-development-only@localhost:5432/offense_demo';
    assert({
      given:
        'development with only DATABASE_URL, an unset NODE_ENV, and a development MIGRATION_DATABASE_URL',
      should:
        'use DATABASE_URL unless a migration credential is named, which wins',
      actual: [
        readMigrationConfig({ NODE_ENV: 'development', DATABASE_URL: local }),
        readMigrationConfig({ DATABASE_URL: local }),
        readMigrationConfig({
          NODE_ENV: 'development',
          DATABASE_URL: runtime,
          MIGRATION_DATABASE_URL: local,
        }),
      ],
      expected: [
        { databaseUrl: local },
        { databaseUrl: local },
        { databaseUrl: local },
      ],
    });
  });

  test('refuses a missing or malformed credential outside production', () => {
    assert({
      given: 'no database URL, and a non-PostgreSQL migration URL',
      should: 'refuse naming the field without echoing its value',
      actual: [
        failureOf({ NODE_ENV: 'development' }),
        failureOf({ MIGRATION_DATABASE_URL: 'redis://secret@localhost:6379' }),
      ],
      expected: [
        'Invalid migration configuration: DATABASE_URL',
        'Invalid migration configuration: MIGRATION_DATABASE_URL (Expected PostgreSQL URL)',
      ],
    });
  });
});
