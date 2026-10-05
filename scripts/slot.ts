/**
 * `bun slot:up | slot:down | slot:prune` (ADR 0034): per-checkout databases
 * and Redis namespaces on the one shared local stack.
 *
 *   up         bring the shared stack up, prune orphans, create and migrate
 *              this checkout's dev, test and e2e databases, provision the test
 *              logins, write its .env values. Idempotent: a second run
 *              changes nothing.
 *   reset-e2e  empty and re-migrate this checkout's e2e database and delete
 *              its e2e Redis keys, so a browser run starts from the baseline.
 *   down       drop this worktree's databases and Redis keys (refused on main).
 *   prune      drop the databases and Redis keys of worktrees git no longer
 *              lists.
 *
 * The server comes from the checkout's .env URLs (host, port, credentials),
 * which is how the admin connection is injected. `--checkout <path>` and
 * `--env <path>` select another checkout and .env file; Compose honours
 * COMPOSE_FILE and COMPOSE_PROJECT_NAME when set.
 */
import { RedisClient, type SQL } from 'bun';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createSlotDatabase,
  dropSlotDatabase,
  listSlotDatabases,
  provisionTestRoles,
  resetPublicSchema,
  setSlotDatabaseComment,
  withSlotLock,
} from '@offense-demo/db/slots';
import { dropAllTestRunDatabases } from '@offense-demo/db/test-runs';
import { deleteNamespace } from '@offense-demo/redis/namespaces';
import { readEnvValue, rewriteEnv, slotEnvValues } from './slot-env';
import { e2eRole, serviceRefusal, type Slot } from './slot-model';
import {
  APP_PORT_ENV,
  parsePortBlockComment,
  pickPortBlock,
  portBlockComment,
  portBlockPorts,
} from './slot-ports';
import { STACK_PORT_ENV, withStackPorts } from './slot-naming';
import { stackReachable, withDatabase } from './slot-stack';
import { clearTestNamespaces, requireRedisDatabases } from './slot-redis';
import {
  inspectOrphans,
  liveSlotIds,
  migrate,
  migratorOf,
  openServices,
  resolveCheckout,
  run,
  worktreeDatabases,
  type Checkout,
  type SlotServices,
} from './slot-services';

const root = resolve(import.meta.dir, '..');

async function prune(services: SlotServices, checkout: Checkout) {
  const orphans = await inspectOrphans(services, await liveSlotIds(checkout));
  for (const database of orphans.databases)
    await dropSlotDatabase(services.admin, database);
  for (const namespace of orphans.namespaces)
    for (const client of services.redis)
      await deleteNamespace(client, namespace);
  return orphans;
}

const isPortFree = (port: number): boolean => {
  try {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data() {} },
    });
    listener.stop(true);
    return true;
  } catch {
    return false;
  }
};

async function claimPortBlock(admin: SQL, slot: Slot): Promise<number> {
  const databases = await listSlotDatabases(admin, worktreeDatabases);
  const own = parsePortBlockComment(
    databases.find(({ name }) => name === slot.database)?.comment,
  );
  const claimed = databases
    .filter(({ name }) => name !== slot.database)
    .map(({ comment }) => parsePortBlockComment(comment))
    .filter((block): block is number => block !== undefined);
  const block = pickPortBlock({
    own,
    claimed,
    isFree: (candidate) => portBlockPorts(candidate).every(isPortFree),
  });
  if (own === undefined)
    await setSlotDatabaseComment(admin, slot.database, portBlockComment(block));
  return block;
}

async function readEnvFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(`${path} is missing: copy .env.example to .env first`);
  }
}

const envOf = (content: string) =>
  withStackPorts(
    {
      DATABASE_URL: readEnvValue(content, 'DATABASE_URL'),
      TEST_DATABASE_URL: readEnvValue(content, 'TEST_DATABASE_URL'),
      REDIS_URL: readEnvValue(content, 'REDIS_URL'),
      E2E_REDIS_URL: readEnvValue(content, 'E2E_REDIS_URL'),
      TEST_REDIS_URL: readEnvValue(content, 'TEST_REDIS_URL'),
      PORT: readEnvValue(content, 'PORT'),
      [APP_PORT_ENV]:
        process.env[APP_PORT_ENV] ?? readEnvValue(content, APP_PORT_ENV),
    },
    {
      [STACK_PORT_ENV.postgres]: readEnvValue(content, STACK_PORT_ENV.postgres),
      [STACK_PORT_ENV.redis]: readEnvValue(content, STACK_PORT_ENV.redis),
      ...process.env,
    },
  );

const describeOrphans = (ids: readonly string[]) =>
  ids.length === 0 ? 'none' : ids.join(', ');

const slotDatabases = (slot: Slot) =>
  [slot.database, slot.testDatabase, slot.e2eDatabase] as const;

async function up(checkout: Checkout, envPath: string) {
  const content = await readEnvFile(envPath);
  const env = envOf(content);
  // Refuse a stale or remote .env before touching Docker or any service.
  const refusal = serviceRefusal(env);
  if (refusal) throw new Error(refusal);
  await migratorOf(checkout.path);
  // Start the stack only when it is down: `compose up` on a running stack
  // recreates it whenever this branch's compose file differs, wiping every
  // slot's Redis keys and restarting Postgres under every checkout.
  if (!(await stackReachable(env)))
    await run(['docker', 'compose', 'up', '-d', '--wait'], root, {
      ...process.env,
      COMPOSE_FILE: process.env.COMPOSE_FILE ?? 'infra/compose.yaml',
    });
  const services = openServices(env);
  try {
    const { slot } = checkout;
    const { pruned, created, values } = await withSlotLock(
      services.admin,
      async () => {
        const pruned = await prune(services, checkout);
        const created: string[] = [];
        for (const database of slotDatabases(slot))
          if (await createSlotDatabase(services.admin, database))
            created.push(database);
        const portBlock =
          slot.kind === 'worktree'
            ? await claimPortBlock(services.admin, slot)
            : undefined;
        // ISSUE-237: the test database is 2 + the port block, so the
        // server must offer that many databases; fail before writing .env.
        await requireRedisDatabases(
          services.redis[0] as RedisClient,
          portBlock,
        );
        const values = slotEnvValues({ slot, env, portBlock });
        // Under the lock too: the baseline creates cluster-wide roles,
        // which two first-time slot:up runs could otherwise race on.
        for (const database of slotDatabases(slot))
          await migrate(
            withDatabase(env.DATABASE_URL ?? '', database),
            checkout.path,
          );
        await provisionTestRoles(services.admin, e2eRole);
        return { pruned, created, values };
      },
    );
    const rewritten = rewriteEnv(content, values);
    if (rewritten.changed) await writeFile(envPath, rewritten.content);
    process.stdout.write(
      [
        `Slot ${slot.id} (${slot.kind})`,
        `  databases: ${slotDatabases(slot).join(', ')} (created: ${created.join(', ') || 'none'}; migrated)`,
        `  redis namespaces: ${slot.namespace}, ${slot.e2eNamespace}`,
        `  test redis: ${values.TEST_REDIS_URL}`,
        `  ports: app ${values.PORT}, e2e ${values.E2E_PORT}`,
        `  .env: ${rewritten.changed ? 'updated' : 'unchanged'}`,
        `  pruned orphan slots: ${describeOrphans(pruned.ids)}`,
        '',
      ].join('\n'),
    );
  } finally {
    await services.close();
  }
}

async function down(checkout: Checkout, envPath: string) {
  const { slot } = checkout;
  if (slot.kind === 'main')
    throw new Error(
      'slot:down refuses the main checkout: its databases are the shared defaults',
    );
  const services = openServices(envOf(await readEnvFile(envPath)));
  try {
    const removed = await withSlotLock(services.admin, async () => {
      // Run databases first (ISSUE-238): a run's own copy of the slot's test database.
      await dropAllTestRunDatabases(services.admin, slot.testDatabase);
      for (const database of slotDatabases(slot))
        await dropSlotDatabase(services.admin, database);
      let removed = 0;
      for (const client of services.redis)
        for (const namespace of [slot.namespace, slot.e2eNamespace])
          removed += await deleteNamespace(client, namespace);
      // The slot's own test database: every namespace a run left behind.
      removed += await clearTestNamespaces(services.testRedis);
      return removed;
    });
    process.stdout.write(
      `Slot ${slot.id}: dropped ${slotDatabases(slot).join(', ')}; deleted ${removed} Redis keys\n`,
    );
  } finally {
    await services.close();
  }
}

/**
 * Empties the browser suite's database and Redis namespace back to the
 * baseline (ISSUE-17): rows a browser run leaves never reach the test
 * database whose row counts integration evidence reads, and this clears them
 * between runs.
 */
async function resetE2E(checkout: Checkout, envPath: string) {
  const env = envOf(await readEnvFile(envPath));
  const { slot } = checkout;
  const services = openServices(env);
  const database = services.connect(slot.e2eDatabase);
  try {
    const removed = await withSlotLock(services.admin, async () => {
      await resetPublicSchema(database);
      await migrate(
        withDatabase(env.DATABASE_URL ?? '', slot.e2eDatabase),
        checkout.path,
      );
      await provisionTestRoles(services.admin, e2eRole);
      let removed = 0;
      for (const client of services.redis)
        removed += await deleteNamespace(client, slot.e2eNamespace);
      return removed;
    });
    process.stdout.write(
      `Slot ${slot.id}: reset ${slot.e2eDatabase} to the baseline; deleted ${removed} ${slot.e2eNamespace} Redis keys\n`,
    );
  } finally {
    await database.close();
    await services.close();
  }
}

async function pruneCommand(checkout: Checkout, envPath: string) {
  const services = openServices(envOf(await readEnvFile(envPath)));
  try {
    const pruned = await withSlotLock(services.admin, () =>
      prune(services, checkout),
    );
    process.stdout.write(
      `Pruned orphan slots: ${describeOrphans(pruned.ids)}\n`,
    );
  } finally {
    await services.close();
  }
}

async function main(argv: readonly string[]) {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { checkout: { type: 'string' }, env: { type: 'string' } },
  });
  const command = positionals[0];
  const commands = {
    up,
    down,
    prune: pruneCommand,
    'reset-e2e': resetE2E,
  } as const;
  if (!command || !Object.hasOwn(commands, command))
    throw new Error(
      'Usage: bun scripts/slot.ts up|reset-e2e|down|prune [--checkout <path>] [--env <path>]',
    );
  const checkout = await resolveCheckout(values.checkout ?? root);
  await commands[command as keyof typeof commands](
    checkout,
    values.env ? resolve(values.env) : join(checkout.path, '.env'),
  );
}

if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'slot command failed'}\n`,
    );
    process.exitCode = 1;
  }
}
