import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * AUTH-6.1: the e2e wrapper (apps/web/e2e/support/server.ts) adds a mail
 * capture and a reset endpoint around the production server; nothing under
 * apps/web/src imports it, so none of its markers should ever reach the
 * release artifact. This gate proves that by scanning the actual Next
 * production build output, not source — a route removed from source but
 * still emitted by a stale build would slip past a source-only grep.
 */
export const FORBIDDEN_ARTIFACT_MARKERS = [
  'E2E_MAIL_PORT',
  'E2E_EDGE_PORT',
  'e2e/support/server',
  'e2e/support/accounts',
  'addVirtualAuthenticator',
  'resetRateLimits',
] as const;

const FORBIDDEN_ROUTE_PATHS = ['/mails', '/reset'] as const;

/**
 * AUTH-6.3: server-only secret configuration must never reach the
 * browser-shipped bundle. `static/` is the one subtree Next actually serves
 * to the client (server chunks and route manifests live elsewhere in the
 * same build directory and are expected to reference server-only config);
 * scoping the check to it keeps this a real client-leak proof rather than a
 * duplicate of the server-chunk scan above.
 */
export const CLIENT_BUNDLE_SECRET_ENV_VARS = [
  'BETTER_AUTH_SECRET',
  'RECIPIENT_HASH_SECRET',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
  'OPS_PROBE_TOKEN',
] as const;

export function clientBundleSecretIssues(
  relativePath: string,
  content: string,
  secrets: readonly string[],
): string[] {
  if (!relativePath.startsWith('static/')) return [];
  return secrets
    .filter((secret) => secret.length > 0 && content.includes(secret))
    .map(
      () =>
        `${relativePath}: contains a value from a server-only secret environment variable`,
    );
}

// Only the files Next actually serves or ships in the artifact are in scope;
// `cache/` holds the incremental tsbuildinfo/webpack cache, which is neither
// served nor shipped with the deployed artifact.
const skipDirectories = new Set(['cache']);
const scannableExtension = /\.(js|json|html|txt|map)$/;

export function routeManifestIssues(manifestJson: string): string[] {
  const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
  const values = [...Object.keys(manifest), ...Object.values(manifest)].map(
    (value) => String(value),
  );
  return FORBIDDEN_ROUTE_PATHS.filter((path) =>
    values.some((value) => value === path),
  ).map((path) => `route manifest declares forbidden path "${path}"`);
}

export function artifactTextIssues(
  relativePath: string,
  content: string,
): string[] {
  return FORBIDDEN_ARTIFACT_MARKERS.filter((marker) =>
    content.includes(marker),
  ).map((marker) => `${relativePath}: contains forbidden marker "${marker}"`);
}

function listScannableFiles(directory: string, prefix = ''): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(directory, prefix))) {
    if (skipDirectories.has(entry)) continue;
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    const absolutePath = join(directory, relativePath);
    const info = statSync(absolutePath);
    if (info.isDirectory())
      files.push(...listScannableFiles(directory, relativePath));
    else if (scannableExtension.test(entry)) files.push(relativePath);
  }
  return files;
}

const manifestNames = ['app-path-routes-manifest.json', 'routes-manifest.json'];

export async function checkBuildArtifactIsolation(
  buildDir: string,
  clientBundleSecrets: readonly string[] = [],
): Promise<readonly string[]> {
  if (!existsSync(buildDir))
    throw new Error(
      `${buildDir} does not exist — run \`bun run --cwd apps/web build\` (or \`bun run build\`) before this check`,
    );
  const issues: string[] = [];
  for (const manifestName of manifestNames) {
    const manifestPath = join(buildDir, manifestName);
    if (existsSync(manifestPath))
      issues.push(...routeManifestIssues(readFileSync(manifestPath, 'utf8')));
  }
  for (const relativePath of listScannableFiles(buildDir)) {
    const content = readFileSync(join(buildDir, relativePath), 'utf8');
    issues.push(...artifactTextIssues(relativePath, content));
    issues.push(
      ...clientBundleSecretIssues(relativePath, content, clientBundleSecrets),
    );
  }
  return issues;
}

if (import.meta.main) {
  const buildDir = resolve(import.meta.dir, '../apps/web/.next');
  const clientBundleSecrets = CLIENT_BUNDLE_SECRET_ENV_VARS.map(
    (name) => process.env[name] ?? '',
  );
  const issues = await checkBuildArtifactIsolation(
    buildDir,
    clientBundleSecrets,
  );
  for (const issue of issues) console.error(issue);
  if (issues.length === 0)
    console.log(
      `Offense Demo build-artifact isolation: PASS (${buildDir} carries no e2e-only surface)`,
    );
  process.exitCode = issues.length === 0 ? 0 : 1;
}
