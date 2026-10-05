import { createId } from '@paralleldrive/cuid2';
import {
  boolean,
  integer,
  index,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAtColumn, timestampColumn, updatedAtColumn } from './columns';
import { users } from './users';

export const sessions = pgTable(
  'session',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    expiresAt: timestampColumn('expires_at').notNull(),
    token: text('token').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('session_token_unique').on(table.token),
    index('session_user_id_idx').on(table.userId),
    // Supports the hourly retention.session sweep's `expires_at < cutoff
    // ORDER BY expires_at` query (AUTH-7.5, ISSUE-123), the same shape
    // `verification_expires_at_idx` already supports for `verification`.
    index('session_expires_at_idx').on(table.expiresAt),
  ],
);

export const accounts = pgTable(
  'account',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestampColumn('access_token_expires_at'),
    refreshTokenExpiresAt: timestampColumn('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('account_provider_account_unique').on(
      table.providerId,
      table.accountId,
    ),
    index('account_user_id_idx').on(table.userId),
  ],
);

export const verifications = pgTable(
  'verification',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestampColumn('expires_at').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('verification_identifier_idx').on(table.identifier),
    index('verification_expires_at_idx').on(table.expiresAt),
  ],
);

export const passkeys = pgTable(
  'passkey',
  {
    id: text('id').primaryKey().$defaultFn(createId),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('passkey_credential_id_unique').on(table.credentialID),
    index('passkey_user_id_idx').on(table.userId),
    index('passkey_created_at_idx').on(table.createdAt),
  ],
);
