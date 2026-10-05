import { afterAll } from 'bun:test';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import type { Identity } from '@offense-demo/auth';
import { systemClock, systemId } from '@offense-demo/clock';
import { createPasskeyFlows } from './auth-passkey-flows';
import { counts, removeAccount, testDatabaseUrl, withSql } from './fixtures';
import { uniqueName } from './auth-account-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { identify } from '../src/lib/identity';
import { createApp } from '../src/server/app';
import { requireTestServices } from '@offense-demo/config';

/**
 * AUTH-6.2: proves a running app survives a migration re-application and a
 * resource restart without losing live auth state (session, passkey,
 * claimed username). `bun verify` already proves migrations are idempotent
 * against an empty database; this proves an *upgrade over live data* keeps
 * that data intact and the still-running app keeps serving it correctly.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp, identifyAs } = flows.account;

const userIdOf = (identity: Identity): string =>
  identity.state === 'member' || identity.state === 'provisional'
    ? identity.principal.userId
    : (() => {
        throw new Error('expected an authenticated identity');
      })();

const usernameOf = (userId: string) =>
  withSql(async (sql) => {
    const [row] = await sql`SELECT username FROM users WHERE id = ${userId}`;
    return (row as { username: string | null } | undefined)?.username;
  });

test('a migration re-application and a resource restart preserve a live session, passkey and username', async () => {
  const { email, cookie } = await signUp();
  await flows.enrollPasskey(cookie, { name: 'Restart laptop' });
  const username = uniqueName();
  await flows.account.claim(cookie, { username });

  const before = await identifyAs(cookie);
  const userId = userIdOf(before);

  // The account is keyed by the user id signUp() created, so this suite
  // removes it itself, leaving nothing for a later run to count.
  afterAll(() => removeAccount({ email, userId }));

  const beforePasskeys = (await counts({ userId })).passkeys;
  const beforeUsername = await usernameOf(userId);

  // "Migration upgrade": re-apply the already-applied migrations to
  // the live, populated test database via the real migration script — the
  // same script production runs before a deploy restarts the app.
  const migrated = Bun.spawnSync(['bun', 'packages/db/scripts/migrate.ts'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    cwd: `${import.meta.dir}/../../..`,
  });
  const migrationExit = migrated.exitCode;

  // "Application restart": close the running app's pools, then build a new
  // app from the same environment and read the session through it, exactly
  // as a fresh process would.
  const { testApp } = flows.account.flows;
  await testApp.app.close();
  const restarted = createApp({
    env: testApp.env,
    fetch: testApp.mailbox.fetch,
    clock: systemClock,
    ids: systemId,
  });
  afterAll(() => restarted.close());

  const after = await identify(
    restarted.auth(),
    new Headers({ cookie, [CLIENT_IP_HEADER]: testApp.newClient() }),
  );
  const afterPasskeys = (await counts({ userId })).passkeys;
  const afterUsername = await usernameOf(userId);

  assert({
    given:
      'a live session, an enrolled passkey and a username, then a migration re-application and an app restart',
    should:
      'migrate cleanly and serve the same identity, passkey and username afterwards',
    actual: {
      migrationExit,
      identity: after.state,
      userId: userIdOf(after),
      passkeys: afterPasskeys,
      usernameBefore: beforeUsername,
      usernameAfter: afterUsername,
    },
    expected: {
      migrationExit: 0,
      identity: before.state,
      userId,
      passkeys: beforePasskeys,
      usernameBefore: username,
      usernameAfter: username,
    },
  });
  assert({
    given: 'the passkey enrolled before the restart',
    should: 'still be stored for the account',
    actual: beforePasskeys,
    expected: 1,
  });
});
