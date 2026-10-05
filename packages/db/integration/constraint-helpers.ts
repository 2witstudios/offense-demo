import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';

type PostgresFailure = { errno?: unknown; constraint?: unknown };

/**
 * The constraint PostgreSQL named when refusing the statement (SQLSTATE class
 * 23, integrity constraint violation), or null when it was accepted. Any
 * other error is a broken test, not a rejection, and is rethrown.
 */
const rejectedBy = async (
  attempt: () => Promise<unknown>,
): Promise<string | null> => {
  try {
    await attempt();
    return null;
  } catch (error) {
    const { errno, constraint } = error as PostgresFailure;
    if (typeof errno === 'string' && errno.startsWith('23'))
      return typeof constraint === 'string' ? constraint : errno;
    throw error;
  }
};

/**
 * The SQLSTATE PostgreSQL refused the statement with, or 'accepted': for
 * refusals that are not integrity violations (privileges, for one).
 */
export const sqlStateOf = async (attempt: () => Promise<unknown>) => {
  try {
    await attempt();
    return 'accepted';
  } catch (error) {
    const { errno } = error as PostgresFailure;
    if (typeof errno === 'string') return errno;
    throw error;
  }
};

/** True when an integrity constraint refused the statement. */
export const rejected = async (attempt: () => Promise<unknown>) =>
  (await rejectedBy(attempt)) !== null;

type Row = Readonly<Record<string, unknown>>;

/** Cleanup order: children before parents; RESTRICT edges never fire. */
const purgeOrder: ReadonlyArray<readonly [table: string, key: string]> = [
  ['users', 'id'],
];

/**
 * Per-test fixture over one connection. Every inserted key is tracked and
 * deleted in `finally`, so a failing assertion leaves no rows behind.
 */
export class Fixture {
  readonly tracked = new Map<string, string[]>();
  constructor(readonly sql: SQL) {}

  track(table: string, key: string) {
    const keys = this.tracked.get(table) ?? [];
    keys.push(key);
    this.tracked.set(table, keys);
  }

  /** Inserts one row with positional parameters; the key column is tracked. */
  insert(table: string, row: Row, key = 'id') {
    const columns = Object.keys(row);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const keyValue = row[key];
    if (typeof keyValue === 'string') this.track(table, keyValue);
    return this.sql.unsafe(
      `insert into ${table} (${columns.join(', ')}) values (${placeholders.join(', ')})`,
      Object.values(row),
    );
  }

  /** Same statement as `insert`; resolves to whether a constraint refused it. */
  rejects(table: string, row: Row, key = 'id') {
    return rejected(() => this.insert(table, row, key));
  }

  /** Same statement as `insert`; resolves to the refusing constraint or null. */
  rejectedBy(table: string, row: Row, key = 'id') {
    return rejectedBy(() => this.insert(table, row, key));
  }

  async count(table: string, column: string, value: string): Promise<number> {
    const [row] = (await this.sql.unsafe(
      `select count(*)::int as c from ${table} where ${column} = $1`,
      [value],
    )) as Array<{ c: number }>;
    return row?.c ?? 0;
  }

  async user() {
    const id = createId();
    await this.insert('users', { id, username: `u-${id}` });
    return id;
  }

  async purge() {
    for (const [table, key] of purgeOrder) {
      const keys = this.tracked.get(table);
      if (!keys || keys.length === 0) continue;
      // Positional placeholders: `unsafe` flattens an array argument to CSV.
      await this.sql.unsafe(
        `delete from ${table} where ${key} in (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
        keys,
      );
    }
  }
}

export const withFixture = async (
  url: string,
  body: (fixture: Fixture) => Promise<void>,
) => {
  const sql = new SQL(url);
  const fixture = new Fixture(sql);
  try {
    await body(fixture);
  } finally {
    try {
      await fixture.purge();
    } finally {
      await sql.close();
    }
  }
};
