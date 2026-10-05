/**
 * Pure model of local database slots (ADR 0034). One shared Postgres and
 * Redis serve every checkout; each checkout owns the databases and Redis
 * namespaces derived here from its folder, never chosen by hand. The
 * effectful CLI lives in slot.ts; .env values are in slot-env.ts and port
 * blocks in slot-ports.ts.
 */
import { basename } from 'node:path';
import {
  expectedTestRedisDatabase,
  testRedisRefusal,
} from '@offense-demo/config';
import { slotNaming } from './slot-naming';

export type Slot = {
  readonly kind: 'main' | 'worktree';
  readonly id: string;
  readonly database: string;
  readonly testDatabase: string;
  /** The browser suite's own database, so integration never sees its rows. */
  readonly e2eDatabase: string;
  readonly namespace: string;
  readonly e2eNamespace: string;
};

type Env = Readonly<Record<string, string | undefined>>;

// The project slug; the template initializer renames it.
const {
  databaseBase,
  namespaceBase,
  worktreeDatabasePrefix,
  worktreeNamespacePrefix,
  maxIdLength,
} = slotNaming('offense-demo');
// Lowercase words joined by single underscores; `_test` and `_e2e` are
// reserved so every database and namespace name maps back to one slot.
const slotIdPattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
// `_test_run_<8 hex>` names one integration run's database (ISSUE-238).
const reservedSuffix = /_(?:test|e2e)$|_test_run_[0-9a-f]{8}$/;

export const e2eRole = {
  user: `${databaseBase}_e2e`,
  password: 'e2e-loopback-only',
};

const isSlotId = (id: string): boolean =>
  id.length <= maxIdLength &&
  slotIdPattern.test(id) &&
  !reservedSuffix.test(id);

export function worktreeSlot(id: string): Slot {
  if (!isSlotId(id)) throw new Error(`Invalid slot id "${id}"`);
  const hyphenated = id.replaceAll('_', '-');
  return {
    kind: 'worktree',
    id,
    database: `${worktreeDatabasePrefix}${id}`,
    testDatabase: `${worktreeDatabasePrefix}${id}_test`,
    e2eDatabase: `${worktreeDatabasePrefix}${id}_e2e`,
    namespace: `${worktreeNamespacePrefix}${hyphenated}`,
    e2eNamespace: `${worktreeNamespacePrefix}${hyphenated}-e2e`,
  };
}

const mainSlot: Slot = {
  kind: 'main',
  id: databaseBase,
  database: databaseBase,
  testDatabase: `${databaseBase}_test`,
  e2eDatabase: `${databaseBase}_e2e`,
  namespace: namespaceBase,
  e2eNamespace: `${namespaceBase}-e2e`,
};

/** `wt-3ctbm0tw` → `3ctbm0tw`; `Feat-Login` → `feat_login`. */
function slotIdFromFolder(folder: string): string {
  const id = folder
    .toLowerCase()
    .replace(/^wt[-_]/, '')
    .replaceAll('-', '_');
  if (!isSlotId(id))
    throw new Error(
      `Cannot derive a slot from worktree folder "${folder}": use letters, digits and single hyphens, at most ${maxIdLength} characters, not ending in -test or -e2e`,
    );
  return id;
}

/** Paths must already be resolved to real paths by the caller. */
export function deriveSlot({
  checkout,
  mainCheckout,
}: {
  readonly checkout: string;
  readonly mainCheckout: string;
}): Slot {
  return checkout === mainCheckout
    ? mainSlot
    : worktreeSlot(slotIdFromFolder(basename(checkout)));
}

/** Parses `git worktree list --porcelain`; prunable entries are gone. */
export function parseWorktreeList(porcelain: string): {
  readonly main: string;
  readonly worktrees: readonly string[];
} {
  const entries = porcelain
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter(Boolean))
    .filter((lines) => lines[0]?.startsWith('worktree '))
    .map((lines) => ({
      path: (lines[0] ?? '').slice('worktree '.length),
      prunable: lines.some((line) => line.startsWith('prunable')),
    }));
  const [first, ...rest] = entries;
  if (!first) throw new Error('git worktree list returned no main checkout');
  return {
    main: first.path,
    worktrees: rest.filter((entry) => !entry.prunable).map(({ path }) => path),
  };
}

export function liveWorktreeIds(paths: readonly string[]): {
  readonly ids: readonly string[];
  readonly unslotted: readonly string[];
} {
  const owners = new Map<string, string>();
  const unslotted: string[] = [];
  for (const path of paths) {
    let id: string;
    try {
      id = slotIdFromFolder(basename(path));
    } catch {
      unslotted.push(path);
      continue;
    }
    const owner = owners.get(id);
    if (owner)
      throw new Error(
        `Worktrees ${owner} and ${path} derive the same slot "${id}"; rename one folder`,
      );
    owners.set(id, path);
  }
  return { ids: [...owners.keys()], unslotted };
}

const idOfDatabase = (name: string): string | undefined => {
  if (!name.startsWith(worktreeDatabasePrefix)) return undefined;
  const id = name
    .slice(worktreeDatabasePrefix.length)
    .replace(/_test_run_[0-9a-f]{8}$/, '')
    .replace(/_(?:test|e2e)$/, '');
  return isSlotId(id) ? id : undefined;
};

const idOfNamespace = (namespace: string): string | undefined => {
  if (!namespace.startsWith(worktreeNamespacePrefix)) return undefined;
  const id = namespace
    .slice(worktreeNamespacePrefix.length)
    .replace(/-e2e$/, '')
    .replaceAll('-', '_');
  return isSlotId(id) ? id : undefined;
};

/**
 * Worktree slots whose worktree is gone. Names that do not parse as a
 * worktree slot (main, the template, foreign databases) are never selected.
 */
export function findOrphans({
  liveIds,
  databases,
  namespaces,
}: {
  readonly liveIds: readonly string[];
  readonly databases: readonly string[];
  readonly namespaces: readonly string[];
}) {
  const live = new Set(liveIds);
  const orphaned = (id: string | undefined): id is string =>
    id !== undefined && !live.has(id);
  const orphanDatabases = databases.filter((name) =>
    orphaned(idOfDatabase(name)),
  );
  const orphanNamespaces = namespaces.filter((name) =>
    orphaned(idOfNamespace(name)),
  );
  const ids = new Set([
    ...orphanDatabases.map(idOfDatabase),
    ...orphanNamespaces.map(idOfNamespace),
  ]);
  return {
    ids: [...ids].filter((id): id is string => id !== undefined).sort(),
    databases: [...orphanDatabases].sort(),
    namespaces: [...orphanNamespaces].sort(),
  };
}

const databaseName = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    return undefined;
  }
};

const serverOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

/** Every .env value that names a slot or server other than this checkout's. */
export function slotMismatches(slot: Slot, env: Env): readonly string[] {
  const checks: readonly (readonly [string, string | undefined, string])[] = [
    ['DATABASE_URL', databaseName(env.DATABASE_URL), slot.database],
    [
      'TEST_DATABASE_URL',
      databaseName(env.TEST_DATABASE_URL),
      slot.testDatabase,
    ],
    ['E2E_DATABASE_URL', databaseName(env.E2E_DATABASE_URL), slot.e2eDatabase],
    ['REDIS_NAMESPACE', env.REDIS_NAMESPACE, slot.namespace],
    ['E2E_REDIS_NAMESPACE', env.E2E_REDIS_NAMESPACE, slot.e2eNamespace],
  ];
  const names = checks
    .filter(([, actual, expected]) => actual !== expected)
    .map(([key, actual, expected]) =>
      actual === undefined
        ? `${key} is unset, expected "${expected}"`
        : `${key} names "${actual}", expected "${expected}"`,
    );
  const testRedis =
    env.TEST_REDIS_URL === undefined
      ? undefined
      : testRedisRefusal({
          testRedisUrl: env.TEST_REDIS_URL,
          redisUrl: env.REDIS_URL,
          expected: expectedTestRedisDatabase(env.PORT, slot.kind),
        });
  const sharedRedis = testRedis === undefined ? [] : [testRedis];
  const server = serverOf(env.DATABASE_URL);
  const servers = (['TEST_DATABASE_URL', 'E2E_DATABASE_URL'] as const)
    .map((key) => [key, serverOf(env[key])] as const)
    .filter(
      ([, actual]) =>
        server !== undefined && actual !== undefined && actual !== server,
    )
    .map(
      ([key, actual]) =>
        `${key} is on ${actual}, expected the DATABASE_URL server ${server}`,
    );
  return [...names, ...sharedRedis, ...servers];
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a service URL names this machine (the only target tooling admits). */
export function isLoopbackUrl(value: string | undefined): boolean {
  try {
    return loopbackHosts.has(new URL(value ?? '').hostname);
  } catch {
    return false;
  }
}

/**
 * Why slot administration must refuse these service URLs, or undefined.
 * Slot tooling force-drops databases and unlinks namespaces, so it only
 * ever talks to the local shared stack, never a stale or remote server.
 */
export function serviceRefusal(env: Env): string | undefined {
  for (const key of [
    'DATABASE_URL',
    'REDIS_URL',
    'E2E_REDIS_URL',
    'TEST_REDIS_URL',
  ] as const) {
    const value = env[key];
    if (value === undefined) {
      if (key === 'E2E_REDIS_URL' || key === 'TEST_REDIS_URL') continue;
      return `${key} is required in .env`;
    }
    let host: string;
    try {
      host = new URL(value).hostname;
    } catch {
      return `${key} is not a valid URL`;
    }
    if (!loopbackHosts.has(host))
      return `${key} must name the local stack (localhost, 127.0.0.1 or ::1), not ${host}`;
  }
  return undefined;
}

/** Why `bun db:reset` must refuse this target, or undefined to proceed. */
export function resetRefusal(slot: Slot, env: Env): string | undefined {
  if (env.NODE_ENV === 'production') return 'Reset never runs in production';
  if (env.ALLOW_DATABASE_RESET !== 'yes')
    return 'Reset requires ALLOW_DATABASE_RESET=yes';
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    return 'Reset requires a DATABASE_URL';
  }
  if (!loopbackHosts.has(url.hostname))
    return 'Reset requires a loopback DATABASE_URL';
  const name = databaseName(url.toString());
  if (name !== slot.database && name !== slot.testDatabase)
    return `Reset accepts only this checkout's databases (${slot.database}, ${slot.testDatabase}); bun slot:reset-e2e resets ${slot.e2eDatabase}`;
  return undefined;
}
