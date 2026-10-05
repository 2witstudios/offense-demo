import { pgTable, text } from 'drizzle-orm/pg-core';
import { updatedAtColumn } from './columns';

/** The dev fixture seed's content markers (`scripts/seed.ts`). */
export const seedVersions = pgTable('seed_versions', {
  seedName: text('seed_name').primaryKey(),
  version: text('version').notNull(),
  updatedAt: updatedAtColumn(),
});
