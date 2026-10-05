import { sql, type SQL } from 'drizzle-orm';
import { check, customType, integer, timestamp } from 'drizzle-orm/pg-core';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { createAppError } from '@offense-demo/errors';
import { z } from 'zod';

/**
 * Column recipes every table uses (ADR 0029, ADR 0038). Builders are
 * single-use, so each call returns a fresh one.
 */

/**
 * The one timestamp column: timestamptz mapped to Date. Drizzle's string
 * mode relabels the driver's Date with the host's local offset instead of
 * converting it, so it is never used; the application converts to UTC ISO
 * strings at its edge.
 */
export const timestampColumn = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAtColumn = () =>
  timestampColumn('created_at').notNull().defaultNow();

export const updatedAtColumn = () =>
  timestampColumn('updated_at').notNull().defaultNow();

/** Optimistic-concurrency counter; `versionPositive` adds its CHECK. */
export const versionColumn = () => integer('version').notNull().default(1);

export const versionPositive = (table: string, column: PgColumn) =>
  check(`${table}_version_positive`, sql`${column} > 0`);

/**
 * `column IN ('a', 'b')` over a closed vocabulary. Values are constant
 * identifiers from `@offense-demo/protocol` or a schema file, never user input, so
 * they are inlined as literals for drizzle-kit to serialize.
 */
export const oneOf = (column: PgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(', '))})`;

/** `later` is unset or not before `earlier`: a time-ordering CHECK body. */
export const notBefore = (later: PgColumn, earlier: PgColumn): SQL =>
  sql`${later} is null or ${later} >= ${earlier}`;

/**
 * The shape of a jsonb column that has no protocol contract yet because
 * nothing writes it (ISSUE-24): any JSON object. Its first writer replaces
 * it with the protocol schema it writes.
 */
export const jsonObjectSchema = z.record(z.string(), z.json());

/**
 * The only jsonb column (ISSUE-24). It cannot be declared without the
 * schema of the value it stores: every write is parsed first, and a value
 * that does not match fails with a typed `VALIDATION` AppError before it
 * reaches the driver, never as an opaque Postgres type error or a silently
 * stored scalar. The parsed object goes to Bun SQL unencoded, which
 * serializes it as real jsonb. Pair it with `jsonbIsObject`, the database
 * half of the same rule.
 */
export const jsonbColumn = <T extends Record<string, unknown>>(
  name: string,
  schema: z.ZodType<T>,
) =>
  customType<{ data: T; driverData: T }>({
    dataType: () => 'jsonb',
    toDriver: (value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw createAppError(
          'VALIDATION',
          `Invalid value for jsonb column ${name}`,
          parsed.error,
        );
      return parsed.data;
    },
  })(name);

/** `<table>_<column>_is_object`: the database refuses a jsonb scalar or array. */
export const jsonbIsObject = (table: string, column: PgColumn) =>
  check(
    `${table}_${column.name}_is_object`,
    sql`jsonb_typeof(${column}) = 'object'`,
  );
