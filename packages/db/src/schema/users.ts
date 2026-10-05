import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  createdAtColumn,
  timestampColumn,
  updatedAtColumn,
  versionColumn,
  versionPositive,
} from './columns';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username'),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name').notNull().default(''),
    image: text('image'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    version: versionColumn(),
    /**
     * Tombstone (ADR 0029): account deletion scrubs PII and sets this instead
     * of deleting the row, so rows that reference the user keep a valid
     * target. The CHECK makes a tombstone with PII unrepresentable.
     */
    deletedAt: timestampColumn('deleted_at'),
  },
  (table) => [
    uniqueIndex('users_email_unique').on(table.email),
    uniqueIndex('users_username_lower_unique').on(
      sql`lower(${table.username})`,
    ),
    check(
      'users_tombstone_scrubbed',
      sql`${table.deletedAt} is null or (${table.email} is null and ${table.username} is null and ${table.image} is null and ${table.name} = '')`,
    ),
    versionPositive('users', table.version),
  ],
);
