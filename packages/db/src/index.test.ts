import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { outbox } from './schema/outbox';
import { users } from './schema/users';
import * as packageEntry from './index';
import { createDatabase } from './index';
import {
  createTestDatabase,
  fakeSqlWithBrokenListen,
  unreachableDatabase,
  type SinkEvent,
} from './index.test-support';

setupRitewayBun();

describe('package entry surface (ISSUE-8 AC1)', () => {
  test('never re-exports a function that takes a Drizzle transaction/table handle, only the createDatabase factory, the startup role gate and value-typed outbox helpers', () => {
    assert({
      given: "the package entry's exported names",
      should:
        'exclude appendOutboxEvent, drainOutbox, deleteExpiredBatch and the raw outbox table — each takes or is a Drizzle handle, so a caller outside packages/db can only reach the opaque createDatabase() surface',
      actual: Object.keys(packageEntry).sort(),
      expected: [
        'DEFAULT_MAX_CONNECTIONS',
        'OUTBOX_ORIGIN',
        'createDatabase',
        'decodeOutboxCursor',
        'encodeOutboxCursor',
        'refuseSchemaAlteringRole',
      ].sort(),
    });
  });
});

describe('persistence schema', () => {
  test('tables have independent ownership', () => {
    assert({
      given: 'the outbox delivery log and the user table',
      should: 'map to independent PostgreSQL tables',
      actual: [getTableName(outbox), getTableName(users)],
      expected: ['outbox', 'users'],
    });
  });

  test('supports provisional authentication profiles', () => {
    const columns = users as unknown as Record<string, { notNull?: boolean }>;

    assert({
      given: 'verified users before username onboarding',
      should:
        'retain identity fields while allowing only the username to remain provisional',
      actual: {
        hasEmail: 'email' in columns,
        hasEmailVerified: 'emailVerified' in columns,
        hasName: 'name' in columns,
        hasImage: 'image' in columns,
        usernameRequired: columns.username?.notNull,
      },
      expected: {
        hasEmail: true,
        hasEmailVerified: true,
        hasName: true,
        hasImage: true,
        usernameRequired: false,
      },
    });
  });

  test('reads user timestamps as the instant the driver returned', () => {
    // Bun SQL returns timestamptz as Date. Better Auth models these fields as
    // Date, and a string-mode column would relabel the UTC wall time with the
    // process's local offset before the auth adapter re-parses it.
    const stored = new Date('2026-01-01T00:00:00.000Z');

    assert({
      given: 'user timestamps shared with the Better Auth adapter',
      should: 'pass the driver Date through unchanged in any process timezone',
      actual: [users.createdAt, users.updatedAt].map((column) =>
        column.mapFromDriverValue(stored as never),
      ),
      expected: [stored, stored],
    });
  });

  test('declares case-folded username uniqueness', () => {
    const config = getTableConfig(users);

    assert({
      given: 'historical usernames that must keep their spelling',
      should: 'enforce uniqueness on their case-folded values',
      actual: config.indexes.some(
        (index) => index.config.name === 'users_username_lower_unique',
      ),
      expected: true,
    });
  });
});

describe('database health', () => {
  test('reports healthy after a successful round trip', async () => {
    const { database } = createTestDatabase([[]]);

    assert({
      given: 'a database answering a round-trip query',
      should: 'report health',
      actual: await database.health(),
      expected: true,
    });
  });

  test('checkListen reports true after subscribing and unsubscribing', async () => {
    const { database } = createTestDatabase([]);

    assert({
      given: 'a LISTEN that PostgreSQL acknowledges',
      should: 'resolve true and leave no open subscription',
      actual: await database.checkListen(),
      expected: true,
    });
  });

  test('checkListen fails closed when LISTEN is unavailable', async () => {
    const { client } = fakeSqlWithBrokenListen([]);
    const events: SinkEvent[] = [];
    const database = createDatabase({
      url: 'postgresql://unit:unit@127.0.0.1:1/unit',
      eventSink: (event, fields, message) =>
        events.push({ event, fields, message }),
      client,
    });

    await expect(database.checkListen()).rejects.toThrow('listen unavailable');
    assert({
      given: 'a broken LISTEN connection',
      should: 'report the failure through the event sink',
      actual: events.map((event) => event.fields.operation),
      expected: ['checkListen'],
    });
  });
});

describe('database adapter failures', () => {
  test('reports a failed query through the injected event sink', async () => {
    const { database, events } = unreachableDatabase();

    await expect(database.health()).rejects.toMatchObject({
      cause: { code: 'ERR_POSTGRES_CONNECTION_REFUSED' },
    });

    assert({
      given: 'a database query that fails',
      should: 'emit the database query failure event with the operation name',
      actual: events,
      expected: [
        {
          event: 'db.query.failed',
          fields: { operation: 'health' },
          message: 'Database query failed',
        },
      ],
    });
  });
});

describe('runtime role problems', () => {
  test('reports no problems for a DML-only role', async () => {
    const { database } = createTestDatabase([
      [
        {
          superuser: false,
          create_in_public: false,
          owns_public_schema: false,
          owned_objects_in_public: 0,
        },
      ],
    ]);

    assert({
      given: 'role facts showing no way to create or alter schema objects',
      should: 'report no problems',
      actual: await database.runtimeRoleProblems(),
      expected: [],
    });
  });

  test('fails closed when schema public is missing', async () => {
    const { database } = createTestDatabase([[]]);

    await expect(database.runtimeRoleProblems()).rejects.toThrow(
      'Schema public is missing',
    );
  });
});

describe('database lifecycle', () => {
  test('closes the injected client', async () => {
    const { database } = createTestDatabase([]);

    assert({
      given: 'an open database',
      should: 'close without error',
      actual: await database.close(),
      expected: undefined,
    });
  });
});
