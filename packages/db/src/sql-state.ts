/**
 * Whether PostgreSQL refused a statement with `state`. Bun SQL reports the
 * SQLSTATE as `errno` (its `code` is `ERR_POSTGRES_SERVER_ERROR`) inside
 * drizzle's wrapper, so every layer of the cause chain is checked.
 */
const hasSqlState = (error: unknown, state: string): boolean => {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 4;
    depth += 1, current = (current as { cause?: unknown }).cause
  )
    if (
      (current as { errno?: unknown }).errno === state ||
      (current as { code?: unknown }).code === state
    )
      return true;
  return false;
};

/** PostgreSQL unique_violation (SQLSTATE 23505). */
export const isUniqueViolation = (error: unknown): boolean =>
  hasSqlState(error, '23505');

/** PostgreSQL foreign_key_violation (SQLSTATE 23503). */
export const isForeignKeyViolation = (error: unknown): boolean =>
  hasSqlState(error, '23503');
