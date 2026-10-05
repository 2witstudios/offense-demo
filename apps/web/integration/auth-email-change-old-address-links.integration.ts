import { SQL } from 'bun';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { finishedOrBlockedBehind } from '@offense-demo/db/testing';
import { createPasskeyFlows } from './auth-passkey-flows';
import {
  cookieHeader,
  emailOf,
  testDatabaseUrl,
  userIdOf,
  withSql,
} from './fixtures';
import { emailedLinkIdentifier } from '../src/features/auth/emailed-link-token';
import { requireTestServices } from '@offense-demo/config';

/**
 * ISSUE-99 (AUTH-5.6: revoke outstanding old-address auth links): a sign-in
 * link mailed to the old address before an email change completes must stop
 * working once the change completes. Before this, the completion only
 * switched the address, so the old link, redeemed afterwards, found no
 * account at the old address and signed up a brand-new one there.
 *
 * ISSUE-103: Better Auth 1.7.5's `/magic-link/verify` consumes the link,
 * looks the account up by email and inserts the session in separate
 * statements. A sign-in to the old address whose lookup lands before the
 * address switch commits, but whose session insert lands after the change's
 * revoke-all commits, is ordered after the revoke by the user-row lock
 * (ISSUE-22) and so survived it, still authenticated on the account that
 * has moved away from the address it proved.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;
const { linkTokenFor, redeem, userRows } = flows.account.flows;

const signInRow = (token: string) =>
  withSql(
    (sql) =>
      sql`SELECT 1 FROM verification WHERE identifier = ${emailedLinkIdentifier('sign-in', token)}`,
  ).then((rows) => rows.length);

describe('ISSUE-99 an email change revokes the old address sign-in links', () => {
  test('a sign-in link for the old address, redeemed after the change completes, creates no session and no account', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const bystander = flows.account.flows.fresh();
    const oldAddressToken = await linkTokenFor(email);
    const bystanderToken = await linkTokenFor(bystander);
    const { newEmail, verifyToken } = await flows.confirmedEmailChange(cookie);

    const beforeCompletion = await signInRow(oldAddressToken);
    const completion = await flows.confirmEmailPost(verifyToken);
    const afterCompletion = await signInRow(oldAddressToken);
    const bystanderAfter = await signInRow(bystanderToken);
    const lateRedemption = await redeem(oldAddressToken);

    assert({
      given:
        'a sign-in link mailed to the old address before the email change completes, redeemed through the real confirm page afterwards',
      should:
        "delete its stored row in the completion, refuse it without a session, and leave no account at the old address, while another address's link survives",
      actual: {
        completionStatus: completion.status,
        emailAfter: await emailOf(uid),
        storedBeforeCompletion: beforeCompletion,
        storedAfterCompletion: afterCompletion,
        bystanderLinkKept: bystanderAfter,
        lateRedemption: lateRedemption.headers.get('location'),
        lateSession: cookieHeader(lateRedemption),
        accountsAtOldAddress: (await userRows(email)).length,
      },
      expected: {
        completionStatus: 303,
        emailAfter: newEmail,
        storedBeforeCompletion: 1,
        storedAfterCompletion: 0,
        bystanderLinkKept: 1,
        lateRedemption: '/auth/confirm?error=INVALID_TOKEN',
        lateSession: '',
        accountsAtOldAddress: 0,
      },
    });
  });

  test('the old-address links are deleted by the same transaction that switches the address', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const oldAddressToken = await linkTokenFor(email);
    const { verifyToken } = await flows.confirmedEmailChange(cookie);

    // A fixture trigger fires on exactly this stored row's delete and
    // inserts a marker outbox row from inside the deleting transaction
    // (`outbox.txid` defaults to `pg_current_xact_id()`). The committed
    // account row's `xmin` is the transaction that switched its address, so
    // the two match only if the delete ran in that same transaction: moving
    // the delete onto another connection turns this red.
    const markerTopic = `test:link-revoke-marker:${createId()}`;
    const fnName = `link_revoke_marker_${createId()}`;
    const identifier = emailedLinkIdentifier('sign-in', oldAddressToken);
    await withSql((sql) =>
      sql.unsafe(`
        create function "${fnName}"() returns trigger as $body$
        begin
          if old.identifier = '${identifier}' then
            insert into outbox (topic, kind, version, payload)
            values ('${markerTopic}', 'test.link_revoke_marker', 1, '{}'::jsonb);
          end if;
          return old;
        end;
        $body$ language plpgsql
      `),
    );
    await withSql((sql) =>
      sql.unsafe(`
        create trigger "${fnName}_trigger" before delete on verification
        for each row execute function "${fnName}"()
      `),
    );
    let completion: Response;
    try {
      completion = await flows.confirmEmailPost(verifyToken);
    } finally {
      await withSql((sql) =>
        sql.unsafe(
          `drop trigger if exists "${fnName}_trigger" on verification`,
        ),
      );
      await withSql((sql) =>
        sql.unsafe(`drop function if exists "${fnName}"()`),
      );
    }
    // xmin is a 32-bit xid; the marker's xid8 carries the epoch above it.
    const [marker] = await withSql(
      (sql) =>
        sql`SELECT (txid::text::numeric % 4294967296)::text AS xid FROM outbox WHERE topic = ${markerTopic}`,
    );
    const [account] = await withSql(
      (sql) => sql`SELECT xmin::text AS xid FROM users WHERE id = ${uid}`,
    );
    await withSql(
      (sql) => sql`DELETE FROM outbox WHERE topic = ${markerTopic}`,
    );

    assert({
      given:
        'an email-change completion and a fixture trigger that marks the transaction deleting the old-address sign-in link',
      should:
        "complete, and delete the link in the very transaction that committed the account's new address",
      actual: {
        completionStatus: completion.status,
        linkDeleted: marker !== undefined,
        sameTransaction: marker?.xid === account?.xid,
      },
      expected: {
        completionStatus: 303,
        linkDeleted: true,
        sameTransaction: true,
      },
    });
  });
});

// Advisory locks are per database, and every run has a database of its own
// (ISSUE-238), so this key only needs to be distinct from any other
// advisory lock this codebase takes on the same connection.
const INSERT_GATE_KEY = 103_001;

const sessionsOf = (userId: string) =>
  withSql((sql) => sql`SELECT 1 FROM session WHERE user_id = ${userId}`).then(
    (rows) => rows.length,
  );

/**
 * A fixture trigger that holds any session insert for `userId` while the
 * account still holds `email`, until the test's advisory lock is released.
 * It fires after Better Auth has consumed the link and found the account,
 * and before the insert takes its foreign-key lock on the user row, so the
 * sign-in waits at exactly the point ISSUE-103 names. The email change's
 * own session is inserted after the address switch and never waits.
 */
const gateSessionInserts = async (userId: string, email: string) => {
  const fnName = `in_flight_sign_in_gate_${createId()}`;
  await withSql((sql) =>
    sql.unsafe(`
      create function "${fnName}"() returns trigger as $body$
      begin
        if new.user_id = '${userId}' and exists (
          select 1 from users where id = new.user_id and email = '${email}'
        ) then
          perform pg_advisory_xact_lock_shared(${INSERT_GATE_KEY});
        end if;
        return new;
      end;
      $body$ language plpgsql
    `),
  );
  await withSql((sql) =>
    sql.unsafe(`
      create trigger "${fnName}_trigger" before insert on session
      for each row execute function "${fnName}"()
    `),
  );
  return () =>
    withSql(async (sql) => {
      await sql.unsafe(`drop trigger if exists "${fnName}_trigger" on session`);
      await sql.unsafe(`drop function if exists "${fnName}"()`);
    });
};

describe('ISSUE-103 no session survives an email change it straddles', () => {
  test('a sign-in to the old address found before the switch and inserted after the revoke leaves no session', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const oldAddressToken = await linkTokenFor(email);
    const { newEmail, verifyToken } = await flows.confirmedEmailChange(cookie);

    const holder = new SQL(testDatabaseUrl, { max: 1 });
    const observer = new SQL(testDatabaseUrl, { max: 1 });
    const removeGate = await gateSessionInserts(uid, email);
    let released = false;
    try {
      const [{ pid: holderPid }] = (await holder.unsafe(
        'select pg_backend_pid() as pid, pg_advisory_lock($1)',
        [INSERT_GATE_KEY],
      )) as [{ pid: number }];
      // 1. The sign-in consumes the link, finds the account at the old
      //    address and blocks on its session insert.
      const signIn = redeem(oldAddressToken);
      const signInOutcome = await finishedOrBlockedBehind(
        signIn,
        observer,
        holderPid,
        { now: Date.now },
      );
      // 2. The change completes: the address switch commits, then the
      //    revoke-all, which finds no session of the sign-in to remove.
      const completion = await flows.confirmEmailPost(verifyToken);
      // 3. Only now does the sign-in's session insert commit.
      await holder.unsafe('select pg_advisory_unlock($1)', [INSERT_GATE_KEY]);
      released = true;
      const lateSignIn = await signIn;
      const lateCookie = cookieHeader(lateSignIn);

      assert({
        given:
          'a sign-in link to the old address whose account lookup lands before an email change and whose session insert lands after its revocation',
        should:
          'complete the change and leave the sign-in without a session on the account, refused as an expired link',
        actual: {
          signInOutcome,
          completionStatus: completion.status,
          emailAfter: await emailOf(uid),
          lateSignIn: lateSignIn.headers.get('location'),
          lateSessionAuthenticated:
            lateCookie !== '' && (await flows.isAuthenticated(lateCookie)),
          // Only the session the completion issued to the new address.
          sessionsOnAccount: await sessionsOf(uid),
          accountsAtOldAddress: (await userRows(email)).length,
        },
        expected: {
          signInOutcome: 'blocked',
          completionStatus: 303,
          emailAfter: newEmail,
          lateSignIn: '/auth/confirm?error=INVALID_TOKEN',
          lateSessionAuthenticated: false,
          sessionsOnAccount: 1,
          accountsAtOldAddress: 0,
        },
      });
    } finally {
      if (!released)
        await holder
          .unsafe('select pg_advisory_unlock($1)', [INSERT_GATE_KEY])
          .catch(() => {});
      await removeGate();
      await Promise.allSettled([holder.close(), observer.close()]);
    }
  });
});
