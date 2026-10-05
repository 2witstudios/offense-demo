/**
 * Which Postgres database an integration run may touch (ADR 0034, ISSUE-238,
 * ISSUE-249). The runner creates and drops databases, and a suite purges and
 * deletes rows, so both first check that the database is this slot's, on this
 * slot's server, and (for a suite) exactly the run the runner handed it.
 * The slot is told from DATABASE_URL, which `slot:up` writes and no run
 * edits; messages name databases and rules, never a host or credential.
 */

const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const parsed = (value: string | undefined): URL | undefined => {
  try {
    return value === undefined ? undefined : new URL(value);
  } catch {
    return undefined;
  }
};

const databaseOf = (url: URL): string =>
  decodeURIComponent(url.pathname.slice(1));

/** Host and port with every spelling of this machine and the default port made equal. */
const serverOf = (url: URL): string =>
  `${loopback.has(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase()}:${url.port || '5432'}`;

/** The slot's `_test` database name: DATABASE_URL's database (a trailing `_test`, as in CI, allowed) plus `_test`. */
const slotTestDatabase = (databaseUrl: URL): string =>
  `${databaseOf(databaseUrl).replace(/_test$/, '')}_test`;

const runShape = /_test_run_[0-9a-f]{8}$/;

/** Whether the name has the shape of its kind: a slot `_test` database or a run database. */
const shapeRefusal = (kind: 'slot' | 'run', name: string) => {
  if (kind === 'slot')
    return name.endsWith('_test')
      ? undefined
      : 'must name a database ending in _test';
  return runShape.test(name)
    ? undefined
    : "must name this run's database, ending in _test_run_ and 8 hex digits: run suites with bun test:integration, which creates and drops it";
};

/** Whether the name is this slot's own test database, or this process's own run database. */
function identityRefusal(
  kind: 'slot' | 'run',
  name: string,
  expectedBase: string,
  runDatabase: string | undefined,
) {
  if (kind === 'slot')
    return name === expectedBase
      ? undefined
      : "must name this slot's own test database, derived from DATABASE_URL: run bun slot:up";
  const runPrefix = `${expectedBase}_run_`;
  if (
    !name.startsWith(runPrefix) ||
    !/^[0-9a-f]{8}$/.test(name.slice(runPrefix.length))
  )
    return 'must name a database of this slot, derived from DATABASE_URL: run suites with bun test:integration (run bun slot:up)';
  return runDatabase === name
    ? undefined
    : "must name this run's own database, the one the runner handed this process as TEST_RUN_DATABASE: run suites with bun test:integration, which creates and drops it";
}

/**
 * Why `testDatabaseUrl` is not the database this process may use, or
 * undefined when it is. `kind: 'slot'` is the runner's view (the slot's own
 * `_test` database); `kind: 'run'` is a suite's (this run's own database, the
 * one named by `runDatabase`, TEST_RUN_DATABASE, which the runner sets for its
 * child, in this slot and on this slot's server).
 */
export function testDatabaseRefusal({
  kind,
  testDatabaseUrl,
  databaseUrl,
  runDatabase,
}: {
  readonly kind: 'slot' | 'run';
  readonly testDatabaseUrl: string;
  readonly databaseUrl: string | undefined;
  readonly runDatabase?: string | undefined;
}): string | undefined {
  const test = parsed(testDatabaseUrl);
  const slot = parsed(databaseUrl);
  if (test === undefined) return undefined;
  const shape = shapeRefusal(kind, databaseOf(test));
  if (shape) return shape;
  if (slot === undefined)
    return "DATABASE_URL is unset, so this slot's Postgres server and databases cannot be told from another (run bun slot:up)";
  if (serverOf(test) !== serverOf(slot))
    return "names a different Postgres server than DATABASE_URL, expected this slot's shared Postgres (run bun slot:up)";
  return identityRefusal(
    kind,
    databaseOf(test),
    slotTestDatabase(slot),
    runDatabase,
  );
}
