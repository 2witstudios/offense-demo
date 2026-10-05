import { SQL } from 'bun';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createDatabase } from '../src/index';

setupRitewayBun();

const { databaseUrl: ownerUrl } = requireTestServices(process.env);

/**
 * Runs the check through `createDatabase` on one owner connection, as the
 * owner or after `set role`, so `current_user` is exactly the role Fly's
 * DATABASE_URL would log in as. No role is created or dropped: role DDL is
 * cluster-wide and would reach every other slot's suites.
 */
const problemsAs = async (
  role: 'owner' | 'offense_demo_web' | 'offense_demo_realtime',
) => {
  const client = new SQL(ownerUrl, { max: 1 });
  const database = createDatabase({ url: ownerUrl, client });
  try {
    if (role !== 'owner') await client.unsafe(`set role ${role}`);
    return await database.runtimeRoleProblems();
  } finally {
    await database.close();
  }
};

/**
 * ISSUE-39, ISSUE-101: the check web and realtime startup run in
 * production, against the real catalog of the migrated test database, as
 * the migration owner and as each runtime role.
 */
test('refuses the migration owner and accepts offense_demo_web and offense_demo_realtime', async () => {
  const [owner, web, realtime] = [
    await problemsAs('owner'),
    await problemsAs('offense_demo_web'),
    await problemsAs('offense_demo_realtime'),
  ];
  assert({
    given:
      'the migration owner and the offense_demo_web and offense_demo_realtime roles',
    should:
      'report the owner as able to create and own schema objects, and nothing for either runtime role',
    actual: {
      ownerRefused: owner.length > 0,
      ownerOwnsObjects: owner.some((problem) =>
        /^owns \d+ objects in schema public$/.test(problem),
      ),
      web,
      realtime,
    },
    expected: {
      ownerRefused: true,
      ownerOwnsObjects: true,
      web: [],
      realtime: [],
    },
  });
});
