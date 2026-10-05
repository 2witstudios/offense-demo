import { SQL } from 'bun';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { runMigrations } from '../src/migrator';
import { RUNTIME_SESSION } from '../src/session-bounds';

setupRitewayBun();

const { databaseUrl: ownerUrl } = requireTestServices(process.env);

/** The SQLSTATE Bun reports as `errno`, through Drizzle's `cause` wrapping. */
const sqlState = (error: unknown): string => {
  for (let at = error; at instanceof Error; at = at.cause)
    if (typeof (at as { errno?: unknown }).errno === 'string')
      return (at as unknown as { errno: string }).errno;
  return 'unknown';
};

/**
 * The pid of the first backend the database reports blocked behind
 * `blockerPid` (`pg_blocking_pids`, not a timer). Bounded, so a statement
 * that never queues fails the test instead of hanging it.
 */
async function backendBlockedBehind(observer: SQL, blockerPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = (await observer.unsafe(
      'select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid)) limit 1',
      [blockerPid],
    )) as [{ pid: number }?];
    if (row) return row.pid;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no backend blocked behind ${blockerPid} within 5 s`);
}

const settle = async (work: Promise<unknown>) => {
  const started = performance.now();
  try {
    await work;
    return { outcome: 'ok', ms: performance.now() - started };
  } catch (error) {
    return { outcome: sqlState(error), ms: performance.now() - started };
  }
};

/**
 * A hot table of its own, standing in for `outbox` or `session`: a scratch
 * table keeps the DDL (and the unbounded control's successful ALTER) off
 * the tables every other suite on the shared test database writes. It is
 * owned by the migration owner and written by `offense_demo_web`, as production
 * tables are. An open owner transaction holds ROW EXCLUSIVE on it, as a
 * live request's uncommitted insert would.
 */
async function withHotTable(
  run: (fixture: {
    readonly table: string;
    readonly holderPid: number;
    readonly appPid: number;
    readonly observer: SQL;
    readonly appInsert: () => Promise<unknown>;
    readonly releaseHolder: () => Promise<unknown>;
  }) => Promise<void>,
) {
  const table = `deploysafe_probe_${createId()}`;
  const setup = new SQL(ownerUrl, { max: 1 });
  const holder = new SQL(ownerUrl, { max: 1 });
  const observer = new SQL(ownerUrl, { max: 1 });
  // The web pool's own session bounds, as `offense_demo_web`: no raised timeout.
  const app = new SQL(ownerUrl, { max: 1, connection: RUNTIME_SESSION });
  try {
    await setup.unsafe(
      `create table "${table}" (id integer generated always as identity primary key, note text not null)`,
    );
    await setup.unsafe(
      `grant select, insert on "${table}" to offense_demo_web`,
    );
    await app.unsafe('set role offense_demo_web');
    const [{ pid: appPid }] = (await app.unsafe(
      'select pg_backend_pid() as pid',
    )) as [{ pid: number }];
    await holder.unsafe('begin');
    await holder.unsafe(`insert into "${table}" (note) values ('held')`);
    const [{ pid: holderPid }] = (await holder.unsafe(
      'select pg_backend_pid() as pid',
    )) as [{ pid: number }];
    await run({
      table,
      holderPid,
      appPid,
      observer,
      appInsert: () =>
        app.unsafe(`insert into "${table}" (note) values ('live request')`),
      releaseHolder: () => holder.unsafe('rollback'),
    });
  } finally {
    await holder.unsafe('rollback').catch(() => {});
    await setup.unsafe(`drop table if exists "${table}"`);
    await Promise.all([setup, holder, observer, app].map((c) => c.close()));
  }
}

/**
 * ISSUE-112: the release migrator's own session, running a real migration
 * folder through `runMigrations`, gives up on a lock the live app holds
 * within its bound, and the live insert queued behind it still succeeds
 * under the app's unchanged 2 s lock_timeout.
 */
test('the release migrator fails fast on a held lock and live writes keep flowing', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'deploysafe-migrations-'));
  const migrationsTable = `deploysafe_migrations_${createId()}`;
  const journal = new SQL(ownerUrl, { max: 1 });
  try {
    await withHotTable(
      async ({ table, holderPid, appPid, observer, appInsert }) => {
        await mkdir(join(folder, '20990101000000_deploysafe_hot_table'));
        await writeFile(
          join(folder, '20990101000000_deploysafe_hot_table', 'migration.sql'),
          `ALTER TABLE "${table}" ADD COLUMN "added" integer;`,
        );
        const migration = settle(
          runMigrations({
            databaseUrl: ownerUrl,
            migrationsFolder: folder,
            migrationsTable,
            migrationsSchema: 'drizzle',
          }),
        );
        const migratorPid = await backendBlockedBehind(observer, holderPid);
        const live = settle(appInsert());
        // The live insert is queued behind the migrator's lock request, the
        // convoy ISSUE-112 names, before the migrator's bound expires.
        const queuedBehindMigrator =
          (await backendBlockedBehind(observer, migratorPid)) === appPid;
        const [migrated, inserted] = await Promise.all([migration, live]);
        const [{ added }] = (await journal.unsafe(
          `select count(*)::int as added from information_schema.columns where table_name = $1 and column_name = 'added'`,
          [table],
        )) as [{ added: number }];
        const [{ recorded }] = (await journal.unsafe(
          `select count(*)::int as recorded from "drizzle"."${migrationsTable}"`,
        )) as [{ recorded: number }];
        assert({
          given:
            'a release migration altering a table an open app transaction holds, with a live offense_demo_web insert queued behind it',
          should:
            'fail the release with lock_not_available before the app lock bound, leave schema and journal unchanged, and let the live insert succeed',
          actual: {
            queuedBehindMigrator,
            migrator: migrated.outcome,
            // Measured from connect, so the whole release gives up before
            // the app's own lock bound would fail a queued statement.
            migratorGaveUpBeforeApp: migrated.ms < RUNTIME_SESSION.lock_timeout,
            liveInsert: inserted.outcome,
            added,
            recorded,
          },
          expected: {
            queuedBehindMigrator: true,
            migrator: '55P03',
            migratorGaveUpBeforeApp: true,
            liveInsert: 'ok',
            added: 0,
            recorded: 0,
          },
        });
      },
    );
  } finally {
    await journal.unsafe(`drop table if exists "drizzle"."${migrationsTable}"`);
    await journal.close();
    await rm(folder, { recursive: true, force: true });
  }
});

/**
 * The control: the same DDL from an owner session with no lock bound
 * queues indefinitely, and the live insert behind it fails at the app's
 * own 2 s lock_timeout. This is the convoy the migrator's bound prevents.
 */
test('an unbounded DDL session stalls live writes until they fail', async () => {
  await withHotTable(
    async ({ table, holderPid, observer, appInsert, releaseHolder }) => {
      const unbounded = new SQL(ownerUrl, { max: 1 });
      try {
        const ddl = settle(
          unbounded.unsafe(`ALTER TABLE "${table}" ADD COLUMN "added" integer`),
        );
        const ddlPid = await backendBlockedBehind(observer, holderPid);
        const inserted = await settle(appInsert());
        const ddlStillWaiting =
          (await backendBlockedBehind(observer, holderPid)) === ddlPid;
        assert({
          given:
            'DDL with no lock_timeout waiting on a held lock and a live offense_demo_web insert behind it',
          should:
            'keep the DDL waiting and fail the live insert with lock_not_available',
          actual: { liveInsert: inserted.outcome, ddlStillWaiting },
          expected: { liveInsert: '55P03', ddlStillWaiting: true },
        });
        // Releasing the holder lets the scratch DDL finish before teardown.
        await releaseHolder();
        await ddl;
      } finally {
        await unbounded.close();
      }
    },
  );
});
