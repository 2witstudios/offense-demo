import { SQL } from 'bun';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { sqlStateOf } from './constraint-helpers';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/**
 * `offense_demo_realtime` (created by the baseline migration) is created without a password:
 * production sets its runtime credential out of band. Roles are
 * cluster-wide and every checkout's slot shares one cluster (ADR 0034), so
 * this test never sets a password on it: a dedicated single-connection
 * session switches to the role with SET ROLE, which drops the admin's
 * superuser rights and checks every statement against the role's grants.
 */

test('the realtime role can only select the outbox and the column-scoped session identity; any other read or write is refused', async () => {
  let realtime: SQL | undefined;
  try {
    realtime = new SQL(url, { max: 1 });
    await realtime.unsafe('SET ROLE offense_demo_realtime');
    const [session] = await realtime.unsafe('select current_user as role');
    assert({
      given: 'the dedicated session after SET ROLE',
      should: 'run every statement as offense_demo_realtime',
      actual: session?.role,
      expected: 'offense_demo_realtime',
    });

    const selectOutbox = await sqlStateOf(() =>
      realtime!.unsafe('select seq from outbox limit 1'),
    );
    // No grant on users at all (ADR 0032 §7): realtime resolves identity
    // from session.user_id, which carries no PII.
    const selectUsersAnyColumn = await sqlStateOf(() =>
      realtime!.unsafe('select id from users limit 1'),
    );
    const selectSessionIdentity = await sqlStateOf(() =>
      realtime!.unsafe('select id, user_id, expires_at from session limit 1'),
    );
    // The bearer credential; column-scoped grant must never include it.
    const selectSessionToken = await sqlStateOf(() =>
      realtime!.unsafe('select token from session limit 1'),
    );

    const insertOutbox = await sqlStateOf(() =>
      realtime!.unsafe(
        "insert into outbox (topic, kind, version, payload) values ('t', 'k', 1, '{}'::jsonb)",
      ),
    );
    const updateOutbox = await sqlStateOf(() =>
      realtime!.unsafe("update outbox set kind = 'x' where seq = -1"),
    );
    const deleteOutbox = await sqlStateOf(() =>
      realtime!.unsafe('delete from outbox where seq = -1'),
    );
    const updateSession = await sqlStateOf(() =>
      realtime!.unsafe("update session set user_id = 'x' where id = 'none'"),
    );
    assert({
      given: 'reads the role is granted',
      should:
        'succeed for outbox and the three session columns, and refuse users entirely and session.token',
      actual: {
        selectOutbox,
        selectSessionIdentity,
        selectUsersAnyColumn,
        selectSessionToken,
      },
      expected: {
        selectOutbox: 'accepted',
        selectSessionIdentity: 'accepted',
        selectUsersAnyColumn: '42501',
        selectSessionToken: '42501',
      },
    });
    assert({
      given: 'writes anywhere, since the role holds no write grant',
      should: 'refuse every one',
      actual: {
        insertOutbox,
        updateOutbox,
        deleteOutbox,
        updateSession,
      },
      expected: {
        insertOutbox: '42501',
        updateOutbox: '42501',
        deleteOutbox: '42501',
        updateSession: '42501',
      },
    });
  } finally {
    await realtime?.close();
  }
});
