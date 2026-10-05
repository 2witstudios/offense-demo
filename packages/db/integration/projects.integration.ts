import { SQL } from 'bun';
import { readdir } from 'node:fs/promises';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { assertRejects } from '@offense-demo/errors/testing';
import { createDatabase } from '../src/index';
import { withFixture } from './constraint-helpers';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/**
 * PROJ-1.1 against the migrated test database. Every project belongs to a
 * user the fixture created and purges; the owner foreign key's cascade
 * (DEC-2) removes the projects with it, so no test leaves rows behind.
 */

const at = (ms: number) => new Date(Date.UTC(2026, 0, 2) + ms).toISOString();

const project = (
  ownerUserId: string,
  overrides: Partial<{ id: string; name: string; createdAt: string }> = {},
) => {
  const createdAt = overrides.createdAt ?? at(0);
  return {
    id: overrides.id ?? createId(),
    ownerUserId,
    name: overrides.name ?? 'Launch plan',
    status: 'active' as const,
    createdAt,
    updatedAt: createdAt,
  };
};

const withDatabase = async <T>(
  run: (database: ReturnType<typeof createDatabase>) => Promise<T>,
) => {
  const database = createDatabase({ url, maxConnections: 2 });
  try {
    return await run(database);
  } finally {
    await database.close();
  }
};

test('insertProject stores the record with its own timestamps and returns what was stored', async () => {
  await withFixture(url, async (fixture) => {
    const owner = await fixture.user();
    const record = project(owner, {
      name: 'Quarterly review',
      createdAt: '2025-12-31T23:59:59.123Z',
    });
    const returned = await withDatabase((database) =>
      database.insertProject(record),
    );
    const [row] = await fixture.sql`
      select id, owner_user_id, name, status, version, created_at, updated_at
      from projects where id = ${record.id}
    `;
    assert({
      given: 'a project record for an existing user',
      should:
        'store exactly that record (the domain clock, not now()) with version 1, and return it',
      actual: {
        returned,
        stored: {
          id: row.id,
          ownerUserId: row.owner_user_id,
          name: row.name,
          status: row.status,
          version: row.version,
          createdAt: (row.created_at as Date).toISOString(),
          updatedAt: (row.updated_at as Date).toISOString(),
        },
      },
      expected: {
        returned: { ...record, version: 1 },
        stored: { ...record, version: 1 },
      },
    });
  });
});

test("listProjectsForOwner returns only the requested owner's projects", async () => {
  await withFixture(url, async (fixture) => {
    const [alice, bob] = [await fixture.user(), await fixture.user()];
    const aliceProjects = [
      project(alice, { createdAt: at(1) }),
      project(alice, { createdAt: at(2) }),
    ];
    const bobProject = project(bob, { createdAt: at(3) });
    const listed = await withDatabase(async (database) => {
      for (const record of [...aliceProjects, bobProject])
        await database.insertProject(record);
      return {
        alice: await database.listProjectsForOwner(alice),
        bob: await database.listProjectsForOwner(bob),
      };
    });
    assert({
      given: "two owners' projects",
      should: "list each owner's own projects only, newest first",
      actual: {
        alice: listed.alice.map(({ id }) => id),
        bob: listed.bob.map(({ id }) => id),
      },
      expected: {
        alice: [aliceProjects[1]!.id, aliceProjects[0]!.id],
        bob: [bobProject.id],
      },
    });
  });
});

test('projects created at the same instant are ordered by id desc after created_at desc', async () => {
  await withFixture(url, async (fixture) => {
    const owner = await fixture.user();
    const stem = createId().slice(0, 23);
    // Inserted lower id first, so insertion order is not the answer.
    const older = project(owner, { id: `${stem}z`, createdAt: at(1) });
    const lower = project(owner, { id: `${stem}a`, createdAt: at(5) });
    const higher = project(owner, { id: `${stem}b`, createdAt: at(5) });
    const listed = await withDatabase(async (database) => {
      for (const record of [older, lower, higher])
        await database.insertProject(record);
      return database.listProjectsForOwner(owner);
    });
    assert({
      given: 'two projects with the same created_at and an older one',
      should: 'order the tied pair by id desc, then the older project',
      actual: listed.map(({ id }) => id),
      expected: [higher.id, lower.id, older.id],
    });
  });
});

test('given more than 100 projects, lists the newest 100', async () => {
  await withFixture(url, async (fixture) => {
    const owner = await fixture.user();
    const records = Array.from({ length: 101 }, (_, index) =>
      project(owner, { createdAt: at(index * 1000) }),
    );
    const newest100 = records
      .slice(1)
      .reverse()
      .map(({ id }) => id);
    const listed = await withDatabase(async (database) => {
      // Real concurrent writers, so the order cannot come from insertion.
      await Promise.all(
        records.map((record) => database.insertProject(record)),
      );
      return {
        byDefault: await database.listProjectsForOwner(owner),
        overAsked: await database.listProjectsForOwner(owner, { limit: 500 }),
        five: await database.listProjectsForOwner(owner, { limit: 5 }),
      };
    });
    assert({
      given: '101 projects for one owner',
      should:
        'return the newest 100 by default and when asked for more, and the newest 5 when asked for 5',
      actual: {
        byDefault: listed.byDefault.map(({ id }) => id),
        overAsked: listed.overAsked.map(({ id }) => id),
        five: listed.five.map(({ id }) => id),
      },
      expected: {
        byDefault: newest100,
        overAsked: newest100,
        five: newest100.slice(0, 5),
      },
    });
  });
});

test('an owner id that is not a user is refused with VALIDATION and writes no row', async () => {
  await withFixture(url, async (fixture) => {
    const record = project(createId());
    await withDatabase((database) =>
      assertRejects({
        given: 'a project whose owner id names no user',
        should: 'reject with VALIDATION',
        actual: () => database.insertProject(record),
        code: 'VALIDATION',
      }),
    );
    assert({
      given: 'the refused insert',
      should: 'leave no projects row',
      actual: await fixture.count('projects', 'id', record.id),
      expected: 0,
    });
  });
});

test('the database enforces the status vocabulary, a positive version and the owner index', async () => {
  await withFixture(url, async (fixture) => {
    const owner = await fixture.user();
    const row = (overrides: Record<string, unknown>) => ({
      id: createId(),
      owner_user_id: owner,
      name: 'Probe',
      status: 'active',
      ...overrides,
    });
    const refusals = {
      status: await fixture.rejectedBy('projects', row({ status: 'deleted' })),
      version: await fixture.rejectedBy('projects', row({ version: 0 })),
      accepted: await fixture.rejectedBy(
        'projects',
        row({ status: 'archived' }),
      ),
    };
    const [index] = await fixture.sql`
      select pg_get_indexdef(i.indexrelid) as def, i.indpred is null as full
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = 'projects_owner_user_id_idx'
    `;
    const [cascade] = await fixture.sql`
      select confdeltype from pg_constraint
      where conrelid = 'projects'::regclass and contype = 'f'
    `;
    assert({
      given: 'rows written around the adapter',
      should:
        'refuse an unknown status and version 0 by name, keep a full owner index and cascade only on hard delete (DEC-2)',
      actual: { ...refusals, index, onDelete: cascade?.confdeltype },
      expected: {
        status: 'projects_status_check',
        version: 'projects_version_positive',
        accepted: null,
        index: {
          def: 'CREATE INDEX projects_owner_user_id_idx ON public.projects USING btree (owner_user_id)',
          full: true,
        },
        onDelete: 'c',
      },
    });
  });
});

test('the web runtime role holds DML on projects through default privileges', async () => {
  const migrationsDir = new URL('../migrations/', import.meta.url).pathname;
  const folders = (await readdir(migrationsDir)).sort();
  const projectsMigration = (
    await Promise.all(
      folders.map(async (folder) => ({
        folder,
        sql: await Bun.file(`${migrationsDir}${folder}/migration.sql`).text(),
      })),
    )
  ).find(({ sql }) => /create table "projects"/i.test(sql));

  await withFixture(url, async (fixture) => {
    const owner = await fixture.user();
    const [privileges] = await fixture.sql`
      select
        has_table_privilege('offense_demo_web', 'projects', 'SELECT') as "select",
        has_table_privilege('offense_demo_web', 'projects', 'INSERT') as "insert",
        has_table_privilege('offense_demo_web', 'projects', 'UPDATE') as "update",
        has_table_privilege('offense_demo_web', 'projects', 'DELETE') as "delete",
        has_table_privilege('offense_demo_web', 'projects', 'TRUNCATE') as "truncate",
        exists (
          select 1 from pg_default_acl d
          cross join lateral aclexplode(d.defaclacl) a
          where d.defaclobjtype = 'r'
            and a.grantee = 'offense_demo_web'::regrole
            and a.privilege_type = 'DELETE'
        ) as "defaultAcl"
    `;

    // Act as the role on a dedicated session, through the adapter.
    const client = new SQL(url, { max: 1 });
    const database = createDatabase({ url, client });
    const record = project(owner);
    try {
      await client.unsafe('set role offense_demo_web');
      const inserted = await database.insertProject(record);
      const listed = await database.listProjectsForOwner(owner);
      const updated =
        await client`update projects set name = 'Renamed' where id = ${record.id} returning id`;
      const deleted =
        await client`delete from projects where id = ${record.id} returning id`;
      assert({
        given: 'the offense_demo_web role and the projects migration',
        should:
          'hold SELECT, INSERT, UPDATE and DELETE (no TRUNCATE) from the default ACL, with no explicit grant in the migration',
        actual: {
          ...privileges,
          explicitGrant: /\bgrant\b/i.test(projectsMigration?.sql ?? ''),
          inserted: inserted.id,
          listed: listed.map(({ id }) => id),
          updated: updated.length,
          deleted: deleted.length,
        },
        expected: {
          select: true,
          insert: true,
          update: true,
          delete: true,
          truncate: false,
          defaultAcl: true,
          explicitGrant: false,
          inserted: record.id,
          listed: [record.id],
          updated: 1,
          deleted: 1,
        },
      });
    } finally {
      await database.close();
    }
  });
});
