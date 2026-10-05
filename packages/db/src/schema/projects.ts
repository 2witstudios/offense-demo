import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import {
  createdAtColumn,
  oneOf,
  updatedAtColumn,
  versionColumn,
  versionPositive,
} from './columns';
import { users } from './users';

/**
 * The project lifecycle vocabulary. `packages/db` never imports
 * `@offense-demo/domain`, so the vocabulary is this schema file's own
 * constant; the web feature maps it to and from the domain aggregate.
 */
export const projectStatuses = ['active', 'archived'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

/**
 * A member's projects (Projects v1). Ids are application-minted cuid2
 * (ADR 0018). `created_at` / `updated_at` are written explicitly from the
 * domain's injected clock so the row equals the snapshot the domain
 * produced (DEC-3); the `now()` defaults serve any other writer.
 * `version` is the optimistic-concurrency counter, unrelated to the domain
 * snapshot's schema version. The owner foreign key cascades only so test
 * and fixture hard deletes leave no orphans (DEC-2): account deletion
 * tombstones `users`, so erasure never reaches it.
 */
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull(),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('projects_owner_user_id_idx').on(table.ownerUserId),
    check('projects_status_check', oneOf(table.status, projectStatuses)),
    versionPositive('projects', table.version),
  ],
);
