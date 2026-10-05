/**
 * PostgreSQL unique_violation (SQLSTATE 23505). Bun SQL reports it as
 * `errno` (its `code` is `ERR_POSTGRES_SERVER_ERROR`) inside drizzle's
 * wrapper, so every layer of the cause chain is checked.
 */
export const isUniqueViolation = (error: unknown): boolean => {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 4;
    depth += 1, current = (current as { cause?: unknown }).cause
  )
    if (
      (current as { errno?: unknown }).errno === '23505' ||
      (current as { code?: unknown }).code === '23505'
    )
      return true;
  return false;
};
