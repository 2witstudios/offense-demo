/**
 * PostgreSQL session bounds, in milliseconds, set at connect time.
 *
 * The runtime pool (web and realtime) gives up on a statement after 5 s and
 * on a lock after 2 s.
 */
export const RUNTIME_SESSION = {
  statement_timeout: 5000,
  lock_timeout: 2000,
} as const;

/**
 * The release migrator's session (ISSUE-112). Its DDL runs while the
 * previous release still serves: a lock request it cannot grant at once
 * queues every later app statement on that table behind it. Giving up after
 * 1 s, below the runtime pool's 2 s, fails the release with 55P03 while the
 * app statements queued behind it still get their lock in time. The 60 s
 * statement bound stops a runaway statement well inside Fly's 5 minute
 * release_command timeout, so Postgres rolls it back and names it.
 */
export const MIGRATOR_SESSION = {
  lock_timeout: 1000,
  statement_timeout: 60_000,
} as const;
