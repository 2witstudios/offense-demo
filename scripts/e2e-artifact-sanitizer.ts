/**
 * AUTH-6.1: retained Playwright artifacts (server.log, the HTML report, and
 * trace/network archives) can carry a live magic-link token, a session
 * cookie, a private key, or the e2e placeholder secrets baked into
 * playwright.config.ts's webServer.env. This redacts those before upload; it never deletes an
 * artifact, only the sensitive substrings inside it.
 */
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const redactions: readonly (readonly [RegExp, string])[] = [
  // Any PEM private key, such as the e2e TLS edge's (ISSUE-78): an artifact
  // must never carry key material, however short-lived.
  [
    /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/token=[^&\s"'<>]+/gi, 'token=[REDACTED]'],
  [/"cookie"\s*:\s*"[^"]*"/gi, '"cookie":"[REDACTED]"'],
  [/set-cookie:\s*[^\r\n]+/gi, 'set-cookie: [REDACTED]'],
  [/cookie:\s*[^\r\n]+/gi, 'cookie: [REDACTED]'],
  [/authorization:\s*[^\r\n]+/gi, 'authorization: [REDACTED]'],
  [/(__Secure-[\w.-]+)=([^;,\s"'&]+)/g, '$1=[REDACTED]'],
  // The e2e placeholder credentials from playwright.config.ts webServer.env —
  // never a live secret, but redacted anyway so a diff of retained artifacts
  // never trains a reader to recognize the shape of a real one.
  [
    /e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0/g,
    '[REDACTED]',
  ],
  [
    /a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2a1b2/g,
    '[REDACTED]',
  ],
  [/re_e2e_placeholder_not_a_credential/g, '[REDACTED]'],
  [/whsec_ZTJlLXBsYWNlaG9sZGVyLW5vdC1hLXNlY3JldA==/g, '[REDACTED]'],
];

export function redactText(text: string): string {
  return redactions.reduce(
    (redacted, [pattern, replacement]) =>
      redacted.replace(pattern, replacement),
    text,
  );
}

const binaryExtension = /\.(png|jpe?g|webp|gif|woff2?|ttf|otf|ico)$/i;
const zipExtension = /\.zip$/i;

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 512).includes(0);
}

function sanitizeTextFileInPlace(path: string): boolean {
  const buffer = readFileSync(path);
  if (isProbablyBinary(buffer)) return false;
  const original = buffer.toString('utf8');
  const redacted = redactText(original);
  if (redacted === original) return false;
  writeFileSync(path, redacted, 'utf8');
  return true;
}

function walk(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const info = statSync(absolute);
    if (info.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function sanitizeZipInPlace(zipPath: string): boolean {
  const extractDir = mkdtempSync(join(tmpdir(), 'offense-demo-e2e-sanitize-'));
  try {
    const extracted = Bun.spawnSync([
      'unzip',
      '-qq',
      '-o',
      zipPath,
      '-d',
      extractDir,
    ]);
    // An archive this scan cannot open cannot be proven clean either: a
    // corrupt or unreadable trace/network zip must block publication, not
    // pass through unredacted under a "nothing changed" result.
    if (extracted.exitCode !== 0)
      throw new Error(
        `could not extract ${zipPath} for sanitization (unzip exited ${extracted.exitCode}: ${extracted.stderr?.toString().trim()}); refusing to publish an unscanned archive`,
      );
    let changed = false;
    for (const file of walk(extractDir)) {
      if (binaryExtension.test(file)) continue;
      if (sanitizeTextFileInPlace(file)) changed = true;
    }
    if (!changed) return false;
    // zip runs inside extractDir, so its output path must be absolute; the
    // original is replaced only once a complete redacted archive exists.
    const rezippedPath = `${resolve(zipPath)}.sanitized`;
    const rezipped = Bun.spawnSync(['zip', '-qr', rezippedPath, '.'], {
      cwd: extractDir,
    });
    if (rezipped.exitCode !== 0) {
      rmSync(rezippedPath, { force: true });
      throw new Error(
        `could not rezip sanitized archive ${zipPath} (zip exited ${rezipped.exitCode}: ${rezipped.stderr?.toString().trim()})`,
      );
    }
    renameSync(rezippedPath, zipPath);
    return true;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function sanitizeArtifactTree(root: string): {
  scanned: number;
  redacted: number;
} {
  let scanned = 0;
  let redacted = 0;
  let entries: readonly string[];
  try {
    entries = walk(root);
  } catch {
    return { scanned, redacted };
  }
  for (const file of entries) {
    scanned += 1;
    if (zipExtension.test(file)) {
      if (sanitizeZipInPlace(file)) redacted += 1;
      continue;
    }
    if (binaryExtension.test(file)) continue;
    if (sanitizeTextFileInPlace(file)) redacted += 1;
  }
  return { scanned, redacted };
}

if (import.meta.main) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error(
      'usage: bun scripts/e2e-artifact-sanitizer.ts <dir> [dir...]',
    );
    process.exitCode = 1;
  } else {
    for (const root of roots) {
      const { scanned, redacted } = sanitizeArtifactTree(root);
      console.log(
        `sanitized ${root}: scanned ${scanned} file(s), redacted ${redacted}`,
      );
    }
  }
}
