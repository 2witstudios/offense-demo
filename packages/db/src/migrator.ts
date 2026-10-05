import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { MIGRATOR_SESSION } from './session-bounds';

/**
 * Applies the migration folder on one owner connection, bounded by
 * `MIGRATOR_SESSION` so hot-table DDL fails fast. The release command
 * (`scripts/migrate.ts`) passes the committed folder; the lock-bound proof
 * passes a scratch folder and journal so it never touches the real one.
 */
export async function runMigrations({
  databaseUrl,
  migrationsFolder,
  migrationsTable,
  migrationsSchema,
}: {
  readonly databaseUrl: string;
  readonly migrationsFolder: string;
  readonly migrationsTable?: string;
  readonly migrationsSchema?: string;
}): Promise<void> {
  const client = new SQL(databaseUrl, {
    max: 1,
    connection: MIGRATOR_SESSION,
  });
  try {
    await migrate(drizzle({ client }), {
      migrationsFolder,
      ...(migrationsTable === undefined ? {} : { migrationsTable }),
      ...(migrationsSchema === undefined ? {} : { migrationsSchema }),
    });
  } finally {
    await client.close();
  }
}
