/**
 * Reads KEY=value lines the way the repository's env files are written:
 * `#` comments, optional `export`, and single- or double-quoted values.
 * Pure; callers read the file.
 */
export function parseDotenv(text: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    const [, key, rest] = match;
    const quoted = /^(['"])(.*)\1\s*(?:#.*)?$/.exec(rest);
    values[key] = quoted ? quoted[2] : rest.replace(/\s+#.*$/, '').trim();
  }
  return values;
}
