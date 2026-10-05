/**
 * Provision a 64-character auth secret in the local .env as a canonical
 * `<NAME>=<value>` assignment. A canonical non-empty value is preserved
 * verbatim. Non-canonical but loader-supported assignments (`export
 * <NAME>=…`, `<NAME> = …`) rotate: the generated value is appended as the
 * final assignment so dotenv-style last-assignment loaders honor it, and the
 * stale line is left untouched, which makes every repeated run a no-op from
 * then on.
 * The value is written directly into .env and never printed or logged.
 * Provisions BETTER_AUTH_SECRET (session signing) and RECIPIENT_HASH_SECRET
 * (ADR 0044, ISSUE-141: keys the suppression ledger and per-recipient
 * rate-limit buckets independently of BETTER_AUTH_SECRET) — two distinct
 * values, never the same one copied twice.
 * Usage: bun scripts/provision-auth-env.ts
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const secretCharset = /^\S{64}$/;
const PROVISIONED_VARIABLES = [
  'BETTER_AUTH_SECRET',
  'RECIPIENT_HASH_SECRET',
] as const;

export function generateAuthSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function provisionAuthSecret(
  content: string,
  {
    generate,
    variableName = 'BETTER_AUTH_SECRET',
  }: { generate: () => string; variableName?: string },
): { content: string; changed: boolean } {
  // dotenv-style loaders honor the last assignment, so only the final line
  // for this variable counts as the effective value. A whitespace-only
  // value counts as absent so blank and CRLF assignments regenerate.
  const assignmentPattern = new RegExp(`^${variableName}=.*$`, 'gm');
  const assignments = [...content.matchAll(assignmentPattern)];
  const effective = assignments.at(-1);
  if (effective && effective[0].slice(`${variableName}=`.length).trim() !== '')
    return { content, changed: false };
  const secret = generate();
  if (!secretCharset.test(secret))
    throw new Error(
      'Generated auth secret must be 64 non-whitespace characters',
    );
  const written = effective
    ? `${content.slice(0, effective.index)}${variableName}=${secret}${content.slice(effective.index + effective[0].length)}`
    : `${content}${content && !content.endsWith('\n') ? '\n' : ''}${variableName}=${secret}\n`;
  return { content: written, changed: true };
}

/**
 * Runs `provisionAuthSecret` once per variable in `variables` (defaulting
 * to the real `PROVISIONED_VARIABLES`, so a test exercising this without
 * overriding it fails if a variable is ever dropped from that list —
 * `main()`'s loop itself, not just `provisionAuthSecret`, is exercised).
 * Writes once, only if anything changed.
 */
export async function provisionAuthEnv({
  content,
  write,
  generate,
  variables = PROVISIONED_VARIABLES,
  log = console.log,
}: {
  readonly content: string;
  readonly write: (content: string) => Promise<void>;
  readonly generate: () => string;
  readonly variables?: readonly string[];
  readonly log?: (message: string) => void;
}): Promise<{ readonly changedAny: boolean; readonly content: string }> {
  let updated = content;
  let changedAny = false;
  for (const variableName of variables) {
    const result = provisionAuthSecret(updated, { generate, variableName });
    updated = result.content;
    changedAny = changedAny || result.changed;
    log(
      result.changed
        ? `${variableName}: generated a new 64-character value into .env.`
        : `${variableName}: existing value preserved.`,
    );
  }
  if (changedAny) await write(updated);
  return { changedAny, content: updated };
}

const envPath = resolve(import.meta.dir, '..', '.env');

async function main() {
  let content: string;
  try {
    content = await readFile(envPath, 'utf8');
  } catch {
    console.error('Missing .env file; copy .env.example to .env first.');
    process.exitCode = 1;
    return;
  }
  await provisionAuthEnv({
    content,
    write: (written) => Bun.write(envPath, written),
    generate: generateAuthSecret,
  });
}

if (import.meta.main) await main();
