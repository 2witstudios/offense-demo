import { createAccountFlows, uniqueName } from './auth-account-helpers';
import { createTestApp, userIdOf, withSql } from './fixtures';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';

type ProjectBody = {
  readonly project?: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  readonly projects?: ReadonlyArray<{ id: string; name: string }>;
  readonly error?: { code: string; invariantId?: string };
};

type ProjectRow = {
  id: string;
  owner_user_id: string;
  name: string;
  status: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

/** Status and parsed body of one `/api/projects` answer. */
export const read = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as ProjectBody,
});

/** Every stored project row of one owner, as the database holds it. */
export const rowsOf = (userId: string) =>
  withSql(
    (sql) =>
      sql`SELECT id, owner_user_id, name, status, version, created_at, updated_at
          FROM projects WHERE owner_user_id = ${userId}
          ORDER BY created_at, id`,
  ) as Promise<ProjectRow[]>;

/** How many stored projects carry this (suite-unique) name. */
export const projectsNamed = async (name: string) =>
  Number(
    (
      await withSql(
        (sql) =>
          sql`SELECT count(*)::int AS count FROM projects WHERE name = ${name}`,
      )
    )[0]?.count,
  );

/**
 * The projects suites' harness: accounts made through the real sign-up,
 * confirm and username routes of the suite's own app, and the real
 * `/api/projects` handlers over real PostgreSQL and Redis. The app removes
 * its accounts after the suite, and their projects with them (DEC-2).
 */
export function createProjectFlows() {
  const testApp = createTestApp();
  const { signUp, claim } = createAccountFlows(testApp);
  const { routes, jsonPost, newClient, origin } = testApp;

  /** A signed-in account with no username yet: provisional. */
  const provisionalAccount = async () => {
    const { email, cookie } = await signUp();
    return { cookie, userId: (await userIdOf(email))! };
  };

  /** A full member: signed up through the real routes and given a username. */
  const memberAccount = async () => {
    const account = await provisionalAccount();
    const claimed = await claim(account.cookie, { username: uniqueName() });
    if (claimed.status !== 201) throw new Error('username claim failed');
    return account;
  };

  const create = (
    cookie: string | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    routes.projects.POST(
      jsonPost('/api/projects', body, {
        ...(cookie ? { cookie } : {}),
        ...headers,
      }),
    );

  const list = (cookie: string | null) =>
    routes.projects.GET(
      new Request(`${origin}/api/projects`, {
        method: 'GET',
        headers: {
          ...(cookie ? { cookie } : {}),
          [CLIENT_IP_HEADER]: newClient(),
        },
      }),
    );

  return { provisionalAccount, memberAccount, create, list };
}
