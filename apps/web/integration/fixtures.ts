import { afterAll, setDefaultTimeout } from 'bun:test';
import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { requireTestServices } from '@offense-demo/config';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import { deleteNamespace } from '@offense-demo/redis/namespaces';
import {
  createBoundedTestClient,
  openTestRedis,
  testNamespace,
  type TestRedis,
} from '@offense-demo/redis/testing';
import { systemClock, systemId } from '@offense-demo/clock';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { createApp } from '../src/server/app';
import type { AfterResponseLimits } from '../src/features/auth/after-response';
import { createRoutes } from '../src/server/routes';
import { authTestEnv } from '../src/features/auth/auth-server.test-support';
import { createMailbox, removeMailRecords } from './mailbox';

/**
 * The one fixture module for the web integration suites (ISSUE-11): the
 * test environment, the app a suite builds for itself, the accounts it
 * creates, their cleanup and their row counts. Suites that drive the REAL
 * route handlers (`/api/auth/[...all]`, `/auth/confirm`, the Resend webhook)
 * build their own app with `createTestApp`: its own validated environment,
 * Redis namespace, mailbox, log output and client addresses, so no suite
 * depends on which others ran first. Only the outbound mail transport is
 * substituted: the production Resend sender runs unchanged and its HTTP call
 * lands on the suite's mailbox `fetch`. Suites that exercise the Better Auth
 * persistence seams directly build `auth-server-harness.ts`'s server over
 * the same `authTestEnv`.
 */

export const { databaseUrl: testDatabaseUrl, redisUrl: testRedisUrl } =
  requireTestServices(process.env);

export const origin = authTestEnv.PUBLIC_APP_URL;
export const webhookSecret = `whsec_${Buffer.from(createId() + createId()).toString('base64')}`;

// 198.18.0.0/15 (RFC 2544, benchmarking): 512 /24s of 254 hosts each.
const CLIENT_NETWORKS = 512;
const CLIENT_SPACE = CLIENT_NETWORKS * 254;

/**
 * Fresh client identities, as the ingress would stamp them, from the
 * benchmarking range. Each call is a new address, and consecutive calls are
 * in different /24s, so a suite's clients are independent of the per-/24
 * magic-link limit (AUTH-3.10) as well as the per-address one. The sequence
 * refuses to repeat rather than wrap into an address a limit already
 * counted.
 */
function createClients() {
  let issued = 0;
  return () => {
    issued += 1;
    if (issued > CLIENT_SPACE)
      throw new Error('Client address space exhausted for this suite');
    const network = issued % CLIENT_NETWORKS;
    const host = Math.floor(issued / CLIENT_NETWORKS) + 1;
    return `198.${18 + (network >> 8)}.${network & 255}.${host}`;
  };
}

/** Runs `work` on a short-lived client with a namespace's key list. */
async function withNamespaceKeys<T>(
  namespace: string,
  work: (client: TestRedis, keys: string[]) => Promise<T>,
) {
  const client = openTestRedis(testRedisUrl);
  try {
    const keys = (await client.send('KEYS', [`${namespace}:*`])) as string[];
    return await work(client, keys);
  } finally {
    client.close();
  }
}

/**
 * One suite's own application: `createApp` over the test services with a
 * fresh Redis namespace and a private mailbox, the route handlers built from
 * it, and request builders stamping this suite's own client addresses.
 * Pass environment overrides (an https PUBLIC_APP_URL, say) to vary the
 * app. Closes itself after the suite.
 */
export function createTestApp(
  overrides: Readonly<Record<string, string | undefined>> = {},
  afterResponseLimits?: AfterResponseLimits,
) {
  // Real Postgres/Redis and hundreds of concurrent requests: allow shared CI
  // machines headroom instead of a 5s default that fails on contention alone.
  setDefaultTimeout(30_000);
  const redisNamespace = testNamespace(createId());
  const env = {
    ...authTestEnv,
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: testRedisUrl,
    REDIS_NAMESPACE: redisNamespace,
    LOG_LEVEL: 'info',
    RESEND_WEBHOOK_SECRET: webhookSecret,
    ...overrides,
  };
  const appOrigin = env.PUBLIC_APP_URL ?? origin;
  const mailbox = createMailbox();
  // The suite's log output: kept for assertions, never printed.
  const logLines: string[] = [];
  const app = createApp({
    env,
    fetch: mailbox.fetch,
    clock: systemClock,
    ids: systemId,
    logDestination: { write: (line) => logLines.push(line) },
    // ISSUE-237: no key the app writes can be immortal or outlive a run.
    redisClient: createBoundedTestClient(testRedisUrl),
    ...(afterResponseLimits ? { afterResponseLimits } : {}),
  });
  const newClient = createClients();
  const jsonPost = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${appOrigin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: appOrigin,
        [CLIENT_IP_HEADER]: newClient(),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const formPost = (
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) =>
    new Request(`${appOrigin}/auth/confirm`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: appOrigin,
        [CLIENT_IP_HEADER]: newClient(),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  /** Removes exactly the keys this suite created in its own namespace. */
  // One UNLINK per SCAN page: a DEL per key overran the 30 s teardown for
  // the ~12,000 keys the global-day ceiling suite leaves (ISSUE-192).
  const clearRedisNamespace = async () => {
    const client = openTestRedis(testRedisUrl);
    await deleteNamespace(client, redisNamespace).finally(() => client.close());
  };
  const redisKeys = () =>
    withNamespaceKeys(redisNamespace, (client, keys) =>
      Promise.all(
        keys.map(async (key) => ({
          key,
          ttlMs: Number(await client.send('PTTL', [key])),
        })),
      ),
    );
  /**
   * Every log record this app emitted while `work` ran (its own logger and
   * every child), parsed from the real, redacted output.
   */
  const recordLogs = async <T>(
    work: () => Promise<T>,
  ): Promise<{
    readonly result: T;
    readonly records: ReadonlyArray<Record<string, unknown>>;
  }> => {
    const from = logLines.length;
    const result = await work();
    return {
      result,
      records: logLines
        .slice(from)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  };
  /** The event names this app logged while `run` ran. */
  const withLoggedEvents = async <T>(
    run: () => Promise<T>,
  ): Promise<{ readonly result: T; readonly events: readonly string[] }> => {
    const { result, records } = await recordLogs(run);
    return { result, events: records.map((record) => String(record.event)) };
  };
  // Every account this suite created, by its first email and, once known,
  // its user id: an email change mid-test leaves the id as the only key.
  const accounts: Array<{ email: string; userId?: string }> = [];
  /** A unique address whose account is removed after the suite. */
  // Every address this app hands out carries its namespace, so teardown
  // clears their verification rows in one scan however many there are.
  const emailMarker = `-${redisNamespace}-`;
  const freshEmail = () => {
    const email = `auth${emailMarker}${createId()}@example.test`;
    accounts.push({ email });
    return email;
  };
  /**
   * Keys every tracked account that now has a user by its id too, in one
   * query, so a later email change cannot orphan it.
   */
  const recordAccountIds = async () => {
    const pending = accounts.filter((account) => !account.userId);
    if (pending.length === 0) return;
    const rows = await withSql(
      (sql) =>
        sql`SELECT id, email FROM users WHERE email = ANY(${sql.array(
          pending.map(({ email }) => email),
          'text',
        )}::text[])`,
    );
    for (const { id, email } of rows as Array<{ id: string; email: string }>) {
      const account = pending.find((entry) => entry.email === email);
      if (account) account.userId = id;
    }
  };
  // One ordered teardown: accounts go while the app's pools are still open,
  // and each step runs even when an earlier one fails (a throwing afterAll
  // skips the hooks after it), so the errors are rethrown together.
  afterAll(async () => {
    const errors: unknown[] = [];
    const step = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error);
      }
    };
    await step(() => removeAccounts(accounts, [emailMarker]));
    await step(() => withSql((sql) => removeMailRecords(sql, mailbox)));
    await step(clearRedisNamespace);
    await step(() => app.close());
    if (errors.length > 0)
      throw new AggregateError(errors, 'createTestApp teardown failed');
  });
  return {
    app,
    routes: createRoutes(app),
    env,
    origin: appOrigin,
    mailbox,
    redisNamespace,
    newClient,
    jsonPost,
    formPost,
    clearRedisNamespace,
    redisKeys,
    recordLogs,
    withLoggedEvents,
    freshEmail,
    recordAccountIds,
  };
}

export type TestApp = ReturnType<typeof createTestApp>;

/** The link a captured message carries (both mail shapes have `text`). */
export const linkFrom = (mail: { readonly text: string }) => {
  const found = mail.text.match(/https?:\/\/\S+/)?.[0];
  if (!found) throw new Error('No link in captured mail');
  return new URL(found);
};

export const tokenOf = (link: URL) => link.searchParams.get('token') ?? '';

export const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

export const fixtureEmail = () => `auth-${createId()}@example.test`;

export const isCuid2 = (value: string) => /^[a-z0-9]{24}$/.test(value);

export async function withSql<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(testDatabaseUrl);
  try {
    return await work(sql);
  } finally {
    await sql.close();
  }
}

export const userIdOf = (email: string) =>
  withSql((sql) => sql`SELECT id FROM users WHERE email = ${email}`).then(
    (rows) => rows[0]?.id as string | undefined,
  );

export const emailOf = (userId: string) =>
  withSql((sql) => sql`SELECT email FROM users WHERE id = ${userId}`).then(
    (rows) => rows[0]?.email as string | undefined,
  );

/**
 * An account a suite created: its unique email, its user id, or both (an
 * email change mid-test leaves the id as the only key; a fixture user may
 * have no email). An empty key matches nothing.
 */
type Account =
  | string
  | {
      readonly email?: string | null | undefined;
      readonly userId?: string | null | undefined;
    };
const keysOf = (account: Account) => {
  const { email, userId } =
    typeof account === 'string' ? { email: account, userId: null } : account;
  return { email: email || null, userId: userId || null };
};

export type AccountCounts = {
  readonly users: number;
  readonly sessions: number;
  readonly verifications: number;
  readonly passkeys: number;
};

export const emptyCounts: AccountCounts = {
  users: 0,
  sessions: 0,
  verifications: 0,
  passkeys: 0,
};

/**
 * The rows an account holds, counted over one connection. Verification rows
 * are matched by containment of the unique fixture email (strpos, so `_` and
 * `%` in an address are literal), so a payload shape Better Auth later
 * extends still counts as a leftover.
 */
export const counts = (account: Account): Promise<AccountCounts> =>
  withSql(async (sql) => {
    const { email, userId } = keysOf(account);
    const [row] = await sql`
      WITH owned AS (
        SELECT id FROM users WHERE email = ${email} OR id = ${userId}
      )
      SELECT
        (SELECT count(*) FROM owned)::int AS users,
        (SELECT count(*) FROM session WHERE user_id IN (SELECT id FROM owned))::int AS sessions,
        (SELECT count(*) FROM verification WHERE strpos(value, ${email}) > 0)::int AS verifications,
        (SELECT count(*) FROM passkey WHERE user_id IN (SELECT id FROM owned))::int AS passkeys`;
    return row as AccountCounts;
  });

/**
 * Removes exactly these accounts' records over one connection: the outbox
 * rows on their inbox topics (a session revoke appends one; ISSUE-192), the
 * users (sessions, accounts and passkeys cascade) and the verification rows
 * containing any of `markers` (by default the accounts' emails; a caller
 * whose emails all share a unique marker passes that, one scan instead of
 * one per email). Never touches unrelated rows.
 */
const removeAccounts = (
  accounts: readonly Account[],
  markers?: readonly string[],
) =>
  withSql(async (sql) => {
    const keys = accounts.map(keysOf);
    const emails = keys.flatMap(({ email }) => (email ? [email] : []));
    const userIds = keys.flatMap(({ userId }) => (userId ? [userId] : []));
    const owned =
      (await sql`SELECT id FROM users WHERE email = ANY(${sql.array(emails, 'text')}::text[]) OR id = ANY(${sql.array(userIds, 'text')}::text[])`) as Array<{
        id: string;
      }>;
    const ownedIds = owned.map(({ id }) => id);
    await sql`DELETE FROM outbox WHERE topic = ANY(${sql.array(
      ownedIds.map((id) => buildUserInboxTopic(id)),
      'text',
    )}::text[])`;
    await sql`DELETE FROM users WHERE id = ANY(${sql.array(ownedIds, 'text')}::text[])`;
    await sql`DELETE FROM verification USING unnest(${sql.array([...(markers ?? emails)], 'text')}::text[]) AS fixture(marker) WHERE strpos(verification.value, fixture.marker) > 0`;
  });

/** Removes exactly one account's records; see `removeAccounts`. */
export const removeAccount = (account: Account) => removeAccounts([account]);
