export const base = 'offense_demo_wt_abc_test';
export const dead = `${base}_run_00000001`;
export const live = `${base}_run_00000002`;
export const RUN_BOUND = { maxRunMs: 3_600_000 };

/**
 * Stands in for the admin connection only: lists the given databases, grants
 * or refuses each advisory lock by name, and records every statement.
 */
export function fakeAdmin({
  databases,
  busy = [],
  connected = [],
  hung = [],
  backendPid = 4242,
}: {
  readonly databases: readonly string[];
  readonly busy?: readonly string[];
  /** Databases another session, started within the run bound, is connected to. */
  readonly connected?: readonly string[];
  /** Databases whose every session is older than the run bound (a hung orphan). */
  readonly hung?: readonly string[];
  /** The backend this fake admin connection currently is. */
  readonly backendPid?: number;
}) {
  const statements: string[] = [];
  const admin = Object.assign(async () => databases.map((name) => ({ name })), {
    unsafe: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('pg_backend_pid() as pid'))
        return [{ pid: backendPid }];
      const sessions = /from pg_stat_activity where datname = '([^']+)'/.exec(
        statement,
      );
      if (sessions) {
        const name = sessions[1] ?? '';
        return [
          {
            sessions: connected.includes(name) || hung.includes(name) ? 1 : 0,
            young: connected.includes(name) ? 1 : 0,
          },
        ];
      }
      const lock = /pg_try_advisory_lock\(hashtextextended\('([^']+)'/.exec(
        statement,
      );
      return lock ? [{ free: !busy.includes(lock[1] ?? '') }] : [];
    },
  });
  return { admin: admin as never, statements };
}
