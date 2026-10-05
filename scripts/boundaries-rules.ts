import { posix } from 'node:path';
/**
 * Declarative boundary rules for the architecture scan. Side-effect-free by
 * contract: unit tests import this module directly, so it must not touch the
 * filesystem or process state. The scan itself lives in check-boundaries.ts.
 */

/** Suites, a workspace's integration and e2e folders, and test support. */
const TEST_CODE =
  /^(?:apps|packages)\/[^/]+\/(?:integration|e2e)\/|(?:^|\/)test-support\/|\.(?:test|integration|e2e)\.tsx?$|\.test-support\.tsx?$/;

/**
 * The domain is pure: framework-free, with no third-party runtime
 * dependency and no Node, Bun, filesystem, network or clock import in its
 * production code. Its only workspace edge is `@offense-demo/errors` (enforced by
 * `allowedWorkspaceDependencies`). Its tests may import their test runner.
 */
export const pureWorkspaces = ['@offense-demo/domain'] as const;

export const domainPurityIssue = (
  workspaceName: string,
  specifier: string,
  kind: 'dependency' | 'import',
  importer = '',
): string | null => {
  if (!(pureWorkspaces as readonly string[]).includes(workspaceName))
    return null;
  if (specifier.startsWith('@offense-demo/') || specifier.startsWith('.'))
    return null;
  if (kind === 'import' && TEST_CODE.test(importer)) return null;
  return `${workspaceName}: ${kind} ${specifier} breaks domain purity`;
};

/** Workspace suffixes (after `@offense-demo/`) each workspace may depend on. */
export const allowedWorkspaceDependencies: Record<string, readonly string[]> = {
  domain: ['errors'],
  protocol: [],
  auth: ['errors'],
  errors: ['protocol'],
  db: ['config', 'errors', 'protocol'],
  redis: ['config', 'errors', 'protocol'],
  config: [],
  // Test-only: the redaction tests derive their secret keys from config's
  // schema (ADR 0019); the logger itself imports nothing from it.
  logger: ['config'],
  observability: ['logger'],
  // ADR 0031 §12: the realtime deployment's exact allowed edges. It never
  // depends on `domain`, `apps/web` or a third-party socket library.
  realtime: [
    'protocol',
    'auth',
    'db',
    'redis',
    'clock',
    'config',
    'errors',
    'logger',
    'observability',
  ],
};

/**
 * Mirrors `domainPurityIssue`'s shape: a pure predicate the scan and its
 * unit tests both call, so "a workspace's edges are mechanically enforced"
 * (ADR 0031 §12) is provable without re-deriving the rule in a test fixture.
 * A workspace absent from `allowedWorkspaceDependencies` is unrestricted.
 */
export const forbiddenDependencyIssue = (
  workspacePath: string,
  workspaceName: string,
  dependency: string,
  allowed: Readonly<Record<string, readonly string[]>>,
): string | null => {
  const restrictions = allowed[workspaceName.replace('@offense-demo/', '')];
  if (
    dependency.startsWith('@offense-demo/') &&
    restrictions &&
    !restrictions.includes(dependency.replace('@offense-demo/', ''))
  )
    return `${workspacePath}: forbidden dependency ${dependency}`;
  return null;
};

/**
 * A workspace import must name the package root or a subpath its `exports`
 * map declares (public API, e.g. `@offense-demo/errors/testing`); anything else
 * reaches into another package's files. Third-party subpaths are left to
 * the dependency rules.
 */
export const deepImportIssue = (
  specifier: string,
  exportsOf: (packageName: string) => unknown,
): string | null => {
  if (!specifier.startsWith('@offense-demo/')) return null;
  const packageName = specifier.split('/').slice(0, 2).join('/');
  if (specifier === packageName) return null;
  const exported = exportsOf(packageName);
  const subpath = `.${specifier.slice(packageName.length)}`;
  return exported !== null &&
    typeof exported === 'object' &&
    Object.hasOwn(exported, subpath)
    ? null
    : `workspace deep import ${specifier}`;
};

/** A workspace's `./testing` subpath, or any `*.test-support` module. */
const TEST_SUPPORT_SPECIFIER =
  /^@offense-demo\/[^/]+\/testing$|\.test-support(?:\.tsx?)?$/;

/**
 * Test support (a workspace's `./testing` subpath or a `*.test-support`
 * module) builds fixtures and may import devDependencies such as riteway:
 * only test code may import it (ISSUE-167).
 */
export const testSupportIssue = (
  specifier: string,
  importer: string,
): string | null =>
  TEST_SUPPORT_SPECIFIER.test(specifier) && !TEST_CODE.test(importer)
    ? `production import of test support ${specifier}`
    : null;

/**
 * ADR 0043: the participant app hosts no admin routes or admin surfaces.
 * Privileged operations are pure domain operations taking an explicit
 * principal, wrapped later by a signed internal API for a separate admin
 * app. A path segment counts whether it names a route (plain or grouped,
 * e.g. `admin` or `(admin)`) or a file's base name (`admin.ts`,
 * `admin.test.tsx`); `administration.ts` is a different word and passes.
 */
export const adminSurfaceIssue = (relativePath: string): string | null => {
  if (!relativePath.startsWith('apps/web/src/')) return null;
  const isAdminSegment = (segment: string) =>
    segment.replace(/^\(|\)$/g, '').split('.')[0] === 'admin';
  return relativePath.split('/').some(isAdminSegment)
    ? `${relativePath}: admin surface in the participant app (ADR 0043)`
    : null;
};

/**
 * ISSUE-275: the repository's own `scripts/` holds the runner and tooling
 * (the whole-database Redis sweep among them); no workspace file, test or
 * product, may import from it, however the relative path is spelled (a
 * workspace's own `scripts/` folder is its own code). Package imports are
 * already limited to each package's `exports`, and `scripts/` is not a
 * package.
 */
export const runnerOnlyIssue = (
  specifier: string,
  importer: string,
): string | null =>
  specifier.startsWith('.') &&
  posix
    .normalize(posix.join(posix.dirname(importer), specifier))
    .startsWith('scripts/')
    ? `import of runner-only code from ${specifier}`
    : null;
