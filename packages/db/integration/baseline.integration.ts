import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/**
 * ISSUE-6 and ISSUE-24: what the single baseline must leave in every
 * migrated database, read from the catalog so a rule missing from the
 * migration fails here even when the Drizzle schema declares it.
 */
const withClient = async <T>(run: (client: SQL) => Promise<T>) => {
  const client = new SQL(url, { max: 1 });
  try {
    return await run(client);
  } finally {
    await client.close();
  }
};

const refused = async (attempt: () => Promise<unknown>) => {
  try {
    await attempt();
    return null;
  } catch (error) {
    return (error as { errno?: string }).errno ?? 'unknown';
  }
};

test('every foreign key is covered by an index that leads with its columns', async () => {
  const uncovered = await withClient(
    (client) => client`
      select c.conrelid::regclass::text || '(' || c.conname || ')' as fk
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
      where c.contype = 'f'
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid
            and i.indpred is null
            and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey
        )
      order by 1
    `,
  );
  assert({
    given: 'every foreign key in the public schema',
    should:
      'have a full (non-partial) index whose leading columns are the key columns',
    actual: uncovered.map((row: { fk: string }) => row.fk),
    expected: [],
  });
});

test('the baseline declares the integrity CHECKs the audit listed', async () => {
  const names = await withClient(async (client) =>
    (
      (await client`
        select conname from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
        where contype = 'c' and conname in ${client([
          'users_version_positive',
          'users_tombstone_scrubbed',
          'email_delivery_status_check',
          'email_suppression_reason_check',
          'outbox_payload_is_object',
        ])}
        order by conname
      `) as Array<{ conname: string }>
    ).map((row) => row.conname),
  );
  assert({
    given: 'the migrated schema',
    should:
      'carry the users version and tombstone, email status and reason, and outbox payload CHECKs',
    actual: names,
    expected: [
      'email_delivery_status_check',
      'email_suppression_reason_check',
      'outbox_payload_is_object',
      'users_tombstone_scrubbed',
      'users_version_positive',
    ],
  });
});

test('every jsonb column carries a database CHECK for object shape (ISSUE-24)', async () => {
  const rows = await withClient(
    (client) => client`
      select col.table_name || '.' || col.column_name as col,
        exists (
          select 1 from pg_constraint c
          where c.conrelid = (quote_ident(col.table_name))::regclass
            and c.contype = 'c'
            and c.conname = col.table_name || '_' || col.column_name || '_is_object'
            and pg_get_constraintdef(c.oid) like '%jsonb_typeof(' || col.column_name || ') = ''object''%'
        ) as guarded
      from information_schema.columns col
      where col.table_schema = 'public' and col.data_type = 'jsonb'
      order by 1
    `,
  );
  assert({
    given: 'every jsonb column in the public schema',
    should: 'have a <table>_<column>_is_object CHECK on jsonb_typeof',
    actual: rows.filter((row: { guarded: boolean }) => !row.guarded),
    expected: [],
  });
  assert({
    given: 'the jsonb columns the audit counted',
    should: 'be exactly the known columns',
    actual: rows.map((row: { col: string }) => row.col),
    expected: ['outbox.payload'],
  });
});

test('foreign-key columns are named after what they reference, and every timestamp is timestamptz', async () => {
  const { misnamed, naiveTimestamps } = await withClient(async (client) => ({
    misnamed: (
      (await client`
        select c.conrelid::regclass::text || '.' || a.attname as col,
          c.confrelid::regclass::text as target
        from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and cardinality(c.conkey) = 1
        order by 1
      `) as Array<{ col: string; target: string }>
    ).filter(({ col, target }) => {
      const column = col.split('.')[1] ?? '';
      const suffix: Record<string, string> = { users: 'user_id' };
      const expected = suffix[target];
      return expected !== undefined && !column.endsWith(expected);
    }),
    naiveTimestamps: (
      (await client`
        select table_name || '.' || column_name as col
        from information_schema.columns
        where table_schema = 'public'
          and data_type = 'timestamp without time zone'
        order by 1
      `) as Array<{ col: string }>
    ).map((row) => row.col),
  }));
  assert({
    given: 'every single-column foreign key',
    should: 'name the column <what>_user_id and so on',
    actual: misnamed,
    expected: [],
  });
  assert({
    given: 'every timestamp column',
    should: 'be timestamp with time zone',
    actual: naiveTimestamps,
    expected: [],
  });
});

test('the realtime role holds only the outbox and the session identity columns', async () => {
  const grants = await withClient(
    (client) => client`
      select table_name || coalesce('(' || column_name || ')', '') as grant
      from (
        select table_name, null::text as column_name
        from information_schema.role_table_grants
        where grantee = 'offense_demo_realtime' and privilege_type = 'SELECT'
          and table_schema = 'public'
        union all
        select table_name, column_name
        from information_schema.column_privileges
        where grantee = 'offense_demo_realtime' and privilege_type = 'SELECT'
          and table_schema = 'public' and table_name <> 'outbox'
      ) g
      order by 1
    `,
  );
  assert({
    given: 'the offense_demo_realtime runtime role the baseline creates',
    should:
      'see the outbox and session (id, user_id, expires_at), nothing else',
    actual: grants.map((row: { grant: string }) => row.grant),
    expected: [
      'outbox',
      'session(expires_at)',
      'session(id)',
      'session(user_id)',
    ],
  });
});

/**
 * The runtime roles, checked with SET ROLE on a dedicated session so every
 * statement runs under the role's own grants (as outbox-role.integration.ts
 * does for offense_demo_realtime).
 */
const asRole = async <T>(role: string, run: (client: SQL) => Promise<T>) =>
  withClient(async (client) => {
    await client.unsafe(`set role ${role}`);
    return run(client);
  });

test('offense_demo_web is a DML-only runtime role on every public table and sequence', async () => {
  const privileges = await withClient(
    (client) => client`
      select
        bool_and(has_table_privilege('offense_demo_web', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) as dml,
        bool_or(has_table_privilege('offense_demo_web', c.oid, 'TRUNCATE')) as truncate,
        bool_or(has_table_privilege('offense_demo_web', c.oid, 'REFERENCES')) as references,
        bool_or(has_table_privilege('offense_demo_web', c.oid, 'TRIGGER')) as trigger,
        bool_or(pg_get_userbyid(c.relowner) = 'offense_demo_web') as owns,
        has_schema_privilege('offense_demo_web', 'public', 'USAGE') as usage,
        has_schema_privilege('offense_demo_web', 'public', 'CREATE') as create
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'r'
    `,
  );
  const sequences = await withClient(
    (client) => client`
      select bool_and(has_sequence_privilege('offense_demo_web', c.oid, 'USAGE,SELECT')) as usable
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relkind = 'S'
    `,
  );
  const ddl = await asRole('offense_demo_web', (client) =>
    refused(() => client.unsafe('create table public.web_probe (id integer)')),
  );
  const migrations = await asRole('offense_demo_web', (client) =>
    refused(() =>
      client.unsafe('select count(*) from drizzle.__drizzle_migrations'),
    ),
  );
  assert({
    given: 'the offense_demo_web runtime role the baseline creates',
    should:
      'hold DML on every table and sequence use, and nothing that alters schema',
    actual: {
      ...privileges[0],
      sequences: sequences[0]?.usable,
      ddl,
      migrations,
    },
    expected: {
      dml: true,
      truncate: false,
      references: false,
      trigger: false,
      owns: false,
      usage: true,
      create: false,
      sequences: true,
      ddl: '42501',
      migrations: '42501',
    },
  });
});

test('offense_demo_e2e inherits exactly offense_demo_web and appends to the outbox through it', async () => {
  const [membership] = await withClient(
    (client) => client`
      select
        pg_has_role('offense_demo_e2e', 'offense_demo_web', 'MEMBER') as member,
        (select count(*)::int from information_schema.role_table_grants
          where grantee = 'offense_demo_e2e') as direct_grants
    `,
  );
  const topic = `user:${createId()}:inbox`;
  const insert = await asRole('offense_demo_e2e', (client) =>
    refused(
      () => client`
        insert into outbox (topic, kind, version, payload)
        values (${topic}, 'session.revoked', 1, ${{ entityVersion: 1, kind: 'session.revoked', ids: [] }})
      `,
    ),
  );
  await withClient(
    (client) => client`delete from outbox where topic = ${topic}`,
  );
  assert({
    given: 'the loopback-only e2e login',
    should:
      'be a member of offense_demo_web with no grants of its own, and insert through the bigserial default',
    actual: { ...membership, insert },
    expected: { member: true, direct_grants: 0, insert: null },
  });
});
