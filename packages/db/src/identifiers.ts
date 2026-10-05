/**
 * Identifiers in CREATE/DROP/COMMENT statements cannot be bound as
 * parameters, so every database name is checked against a strict allowlist
 * before it is quoted into SQL (ADR 0034).
 */
const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/;

export function quoteIdentifier(name: string): string {
  if (!identifierPattern.test(name))
    throw new Error('Invalid database identifier');
  return `"${name}"`;
}
