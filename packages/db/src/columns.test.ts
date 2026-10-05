import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { is } from 'drizzle-orm';
import {
  getTableConfig,
  PgTable,
  PgTimestamp,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { isAppError } from '@offense-demo/errors';

setupRitewayBun();

/**
 * Every table under `schema/`, discovered rather than listed, so a table
 * added later is held to the same column rules without editing this test.
 */
const tables = await (async () => {
  const found: PgTable[] = [];
  for (const file of new Bun.Glob('*.ts').scanSync(
    new URL('./schema/', import.meta.url).pathname,
  )) {
    if (file.endsWith('.test.ts')) continue;
    const module = (await import(`./schema/${file}`)) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(module))
      if (is(value, PgTable)) found.push(value);
  }
  return found;
})();

const columnsOf = (predicate: (column: PgColumn) => boolean) =>
  tables.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns
      .filter(predicate)
      .map((column) => ({ name: `${config.name}.${column.name}`, column }));
  });

const refusal = (column: PgColumn, value: unknown) => {
  try {
    column.mapToDriverValue(value);
    return 'accepted';
  } catch (error) {
    return isAppError(error) ? error.code : 'untyped';
  }
};

describe('jsonb columns (ISSUE-24)', () => {
  test('every jsonb column declares its shape and refuses a non-object write with a typed error', () => {
    const jsonb = columnsOf((column) => column.getSQLType() === 'jsonb');
    assert({
      given: 'every jsonb column in the schema',
      should: 'be the known columns',
      actual: jsonb.map(({ name }) => name).sort(),
      expected: ['outbox.payload'],
    });
    assert({
      given: 'a bare string, a number, an array and null bound to each',
      should: 'fail with an AppError VALIDATION before reaching the driver',
      actual: jsonb.map(({ name, column }) => ({
        name,
        refusals: ['x', 1, [], null].map((value) => refusal(column, value)),
      })),
      expected: jsonb.map(({ name }) => ({
        name,
        refusals: ['VALIDATION', 'VALIDATION', 'VALIDATION', 'VALIDATION'],
      })),
    });
  });
});

describe('timestamp columns', () => {
  test('every timestamp is timestamptz mapped to Date through the one helper', () => {
    const timestamps = columnsOf((column) =>
      column.getSQLType().startsWith('timestamp'),
    );
    assert({
      given: 'every timestamp column in the schema',
      should: 'be timestamp with time zone in date mode',
      actual: timestamps
        .filter(
          ({ column }) =>
            !(
              is(column, PgTimestamp) &&
              column.getSQLType() === 'timestamp with time zone'
            ),
        )
        .map(({ name }) => name),
      expected: [],
    });
  });
});

describe('the one timestamp helper', () => {
  test('no schema file but columns.ts builds a timestamp column itself', async () => {
    const directory = new URL('./schema/', import.meta.url).pathname;
    const handRolled: string[] = [];
    for (const file of new Bun.Glob('*.ts').scanSync(directory))
      if (
        file !== 'columns.ts' &&
        /\btimestamp\(/.test(await Bun.file(`${directory}${file}`).text())
      )
        handRolled.push(file);
    assert({
      given: 'every schema file',
      should: 'build timestamps only through timestampColumn and its recipes',
      actual: handRolled.sort(),
      expected: [],
    });
  });
});
