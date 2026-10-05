import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { SQL } from 'bun';
import { resolve } from 'node:path';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/** The agent seed's fixed user ids (`scripts/agent-seed.ts`). */
const seedUserIds = ['k2v9x0f4m8q3w1z7c5n6b4d2', 'a7b3c9d1e5f2k4m6n8p1r3t5'];

/** Removes the rows the seed inserts. */
const removeSeedRows = async (database: SQL) => {
  await database`delete from users where id in ${database(seedUserIds)}`;
  await database`delete from seed_versions where seed_name = 'agent'`;
};

// A filesystem path, not URL.pathname: that stays percent-encoded, so a
// checkout path containing a space would not exist as a spawn cwd.
const repositoryRoot = resolve(import.meta.dir, '../../..');

/**
 * Runs the seed entry point directly instead of `bun run db:seed`, whose
 * `--env-file=.env` exists to supply the development DATABASE_URL. The only
 * database URL the child can see is the `_test` URL validated above.
 */
async function runSeed(): Promise<void> {
  const process = Bun.spawn(['bun', 'scripts/seed.ts'], {
    cwd: repositoryRoot,
    env: { ...Bun.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`seed failed (${exitCode}): ${stderr || stdout}`);
}

describe('agent seed', () => {
  test('rerunning the seed preserves identifiers, data, and its durable version marker', async () => {
    const database = new SQL(url, { max: 1 });
    try {
      await runSeed();
      const first = await database`
        select
          (select jsonb_agg(to_jsonb(users) order by id) from users where id in ${database(seedUserIds)}) as users,
          (select jsonb_agg(to_jsonb(seed_versions) order by seed_name) from seed_versions where seed_name = 'agent') as versions
      `;

      await runSeed();
      const second = await database`
        select
          (select jsonb_agg(to_jsonb(users) order by id) from users where id in ${database(seedUserIds)}) as users,
          (select jsonb_agg(to_jsonb(seed_versions) order by seed_name) from seed_versions where seed_name = 'agent') as versions
      `;

      assert({
        given: 'a seed run against an isolated test database',
        should: 'write both agent users',
        actual: (first[0]?.users as unknown[] | null)?.length,
        expected: seedUserIds.length,
      });
      assert({
        given: 'an already-seeded isolated test database',
        should:
          'preserve the complete seeded records and version marker on rerun',
        actual: second,
        expected: first,
      });
    } finally {
      try {
        await removeSeedRows(database);
      } finally {
        await database.close();
      }
    }
  });
});
