/**
 * The effectful half of one integration run's own database (ADR 0034,
 * ISSUE-238): sweep the databases dead runs left, make and migrate this
 * run's, hand its URL to the work, and always drop it afterwards. The
 * runner's single admin connection holds the run's liveness lock for the
 * whole call, so a run killed anywhere in it leaves a database the next
 * run's sweep drops. The run is migrated with this checkout's own migrator,
 * so every run also proves the migrations apply to an empty database.
 */
import { SQL } from 'bun';
import {
  claimTestRunDatabase,
  dropTestRunDatabase,
  sweepTestRunDatabases,
  testRunDatabaseName,
  testRunLockLost,
  testRunToken,
} from '@offense-demo/db/test-runs';

const withDatabase = (url: string, database: string): string => {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
};

/**
 * Watches a suite process while it runs (ISSUE-250): every `pollMs` it asks
 * whether the run's liveness lock is gone (Postgres cut the runner's
 * connection and Bun reconnected without it). A lost lock kills the suite at
 * once, because a concurrent run's sweep could otherwise take the database
 * out from under it, and reports `lost`; the run then fails loudly. Checked
 * once more after the suite exits, so a lock lost at the very end still fails.
 * A run that outlasts `maxRunMs` (the bound its own sweep protects, ISSUE-272)
 * is killed and reported `timeout`, so no run is ever longer than the bound
 * a concurrent sweep uses to tell a hung orphan from a live run.
 */
export async function superviseRun({
  exited,
  kill,
  lockLost,
  maxRunMs,
  now = Date.now,
  pollMs = 500,
  sleep = (ms: number) => Bun.sleep(ms),
}: {
  readonly exited: Promise<unknown>;
  readonly kill: () => void;
  readonly lockLost: () => Promise<boolean>;
  readonly maxRunMs: number;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}): Promise<'exited' | 'lost' | 'timeout'> {
  const startedAt = now();
  let done = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    await Promise.race([exited, sleep(pollMs)]);
    if (!done && (await lockLost())) {
      kill();
      await exited;
      return 'lost';
    }
    if (!done && now() - startedAt > maxRunMs) {
      kill();
      await exited;
      return 'timeout';
    }
  }
  return (await lockLost()) ? 'lost' : 'exited';
}

export async function withRunDatabase<T>({
  slotDatabaseUrl,
  root,
  maxRunMs,
  onSweep,
  work,
}: {
  /** TEST_DATABASE_URL: the slot's `_test` database, which names the server and the run databases. */
  readonly slotDatabaseUrl: string;
  /** The checkout whose migrations the run applies. */
  readonly root: string;
  /** The longest a run may last (TEST_RUN_MAX_MS): a session older than this is a hung orphan's. */
  readonly maxRunMs: number;
  readonly onSweep: (dropped: readonly string[]) => void;
  readonly work: (run: {
    readonly url: string;
    /** The run database's name: what the runner hands its suites as TEST_RUN_DATABASE. */
    readonly name: string;
    /** Whether the liveness lock is gone (see `superviseRun`). */
    readonly lockLost: () => Promise<boolean>;
  }) => Promise<T>;
}): Promise<T> {
  const slotDatabase = decodeURIComponent(
    new URL(slotDatabaseUrl).pathname.slice(1),
  );
  const admin = new SQL(withDatabase(slotDatabaseUrl, 'postgres'), { max: 1 });
  const name = testRunDatabaseName(
    slotDatabase,
    testRunToken(crypto.getRandomValues(new Uint8Array(4))),
  );
  try {
    onSweep(await sweepTestRunDatabases(admin, slotDatabase, { maxRunMs }));
    const claimedBy = await claimTestRunDatabase(admin, name);
    const runUrl = withDatabase(slotDatabaseUrl, name);
    try {
      const migrated = Bun.spawnSync(
        ['bun', `${root}/packages/db/scripts/migrate.ts`],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: runUrl },
          stdout: 'inherit',
          stderr: 'inherit',
        },
      );
      if (migrated.exitCode !== 0)
        throw new Error(
          `test-integration: migrating this run's database failed (exit ${migrated.exitCode})`,
        );
      return await work({
        url: runUrl,
        name,
        lockLost: () => testRunLockLost(admin, claimedBy),
      });
    } finally {
      // A cut connection fails its first query, then reconnects.
      await dropTestRunDatabase(admin, name).catch(() =>
        dropTestRunDatabase(admin, name),
      );
    }
  } finally {
    await admin.close();
  }
}
