/**
 * The effectful plumbing of `bun slot:*` (ADR 0034), split from slot.ts:
 * which checkout and slot this is, the live worktrees, the admin Postgres
 * and Redis connections, orphan inspection and a checkout's own migrator.
 * db-reset and doctor reuse it; the commands themselves live in slot.ts.
 */
import { RedisClient, SQL } from 'bun';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { listSlotDatabases } from '@offense-demo/db/slots';
import { listNamespaces } from '@offense-demo/redis/namespaces';
import { e2eRedisUrl } from './slot-env';
import {
  deriveSlot,
  findOrphans,
  liveWorktreeIds,
  parseWorktreeList,
  serviceRefusal,
  type Slot,
} from './slot-model';
import { slotNaming } from './slot-naming';
import { withDatabase } from './slot-stack';
import { openOwnTestRedis } from './slot-redis';

const naming = slotNaming('offense-demo');
export const worktreeDatabases = naming.worktreeDatabasePrefix;
const worktreeNamespaces = naming.worktreeNamespacePrefix;

export const run = async (
  command: readonly string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<string> => {
  const child = Bun.spawn([...command], {
    cwd,
    env: env ?? process.env,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error(`${command.slice(0, 3).join(' ')} failed`);
  return output;
};

const realOrSame = (path: string) => realpath(path).catch(() => path);

export type Checkout = {
  readonly path: string;
  readonly slot: Slot;
};

const readWorktrees = async (path: string) => {
  const list = parseWorktreeList(
    await run(['git', 'worktree', 'list', '--porcelain'], path),
  );
  return {
    main: await realOrSame(list.main),
    worktrees: await Promise.all(list.worktrees.map(realOrSame)),
  };
};

export async function resolveCheckout(start: string): Promise<Checkout> {
  const path = await realOrSame(
    (await run(['git', 'rev-parse', '--show-toplevel'], start)).trim(),
  );
  const { main } = await readWorktrees(path);
  return { path, slot: deriveSlot({ checkout: path, mainCheckout: main }) };
}

/**
 * Slot ids of every live worktree of the checkout's repository, this one
 * included. Read under the slot lock, right before pruning, so a worktree
 * created (and slotted) while this run waited is never taken for an orphan.
 */
export async function liveSlotIds(
  checkout: Checkout,
): Promise<readonly string[]> {
  const { ids } = liveWorktreeIds(
    (await readWorktrees(checkout.path)).worktrees,
  );
  return checkout.slot.kind === 'worktree'
    ? [...new Set([...ids, checkout.slot.id])]
    : ids;
}

export type SlotServices = {
  readonly admin: SQL;
  readonly connect: (database: string) => SQL;
  /** The dev (REDIS_URL) and e2e Redis databases every slot writes to. */
  readonly redis: readonly RedisClient[];
  /** This slot's own test Redis database (TEST_REDIS_URL), when .env names one. */
  readonly testRedis: RedisClient | undefined;
  readonly close: () => Promise<void>;
};

export function openServices(
  env: Readonly<Record<string, string | undefined>>,
): SlotServices {
  const refusal = serviceRefusal(env);
  if (refusal || !env.DATABASE_URL || !env.REDIS_URL)
    throw new Error(refusal ?? 'DATABASE_URL and REDIS_URL are required');
  const server = env.DATABASE_URL;
  const connect = (database: string) =>
    new SQL(withDatabase(server, database), { max: 1, connectionTimeout: 5 });
  const admin = connect('postgres');
  const redisUrls = [
    ...new Set([
      env.REDIS_URL,
      env.E2E_REDIS_URL ?? e2eRedisUrl(env.REDIS_URL),
    ]),
  ];
  const redis = redisUrls.map((url) => new RedisClient(url));
  const testRedis = openOwnTestRedis(env);
  return {
    admin,
    connect,
    redis,
    testRedis,
    close: async () => {
      for (const client of redis) client.close();
      testRedis?.close();
      await admin.close({ timeout: 5 });
    },
  };
}

export async function inspectOrphans(
  services: SlotServices,
  liveIds: readonly string[],
) {
  const databases = (
    await listSlotDatabases(services.admin, worktreeDatabases)
  ).map(({ name }) => name);
  const namespaces = [
    ...new Set(
      (
        await Promise.all(
          services.redis.map((client) =>
            listNamespaces(client, worktreeNamespaces),
          ),
        )
      ).flat(),
    ),
  ];
  return findOrphans({ liveIds, databases, namespaces });
}

/** The checkout's own migrator: its branch may be behind or ahead of ours. */
export async function migratorOf(checkoutPath: string): Promise<string> {
  const migrator = join(checkoutPath, 'packages/db/scripts/migrate.ts');
  if (!(await Bun.file(migrator).exists()))
    throw new Error(`${migrator} is missing; cannot migrate this slot`);
  return migrator;
}

/** Applies the given checkout's own migrations with its own migrator. */
export async function migrate(
  databaseUrl: string,
  checkoutPath: string,
): Promise<void> {
  await run(['bun', await migratorOf(checkoutPath)], checkoutPath, {
    ...process.env,
    DATABASE_URL: databaseUrl,
  });
}
