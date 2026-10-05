import { fileURLToPath } from 'node:url';
import { readMigrationConfig } from '@offense-demo/config';
import { runMigrations } from '../src/migrator';

// Production migrates only as the owner in MIGRATION_DATABASE_URL, never
// the runtime DATABASE_URL (ISSUE-39); errors name fields, never values.
// The session is lock-bounded (ISSUE-112): see src/session-bounds.ts.
const { databaseUrl } = readMigrationConfig(process.env);
await runMigrations({
  databaseUrl,
  migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
});
