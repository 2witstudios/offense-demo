import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createId } from '@paralleldrive/cuid2';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import { createPasskeyFlows } from './auth-passkey-flows';
import { cookieHeader, emailOf, userIdOf, withSql } from './fixtures';
import { EMAIL_CHANGE_LINK_EXPIRES_IN_SECONDS } from '../src/features/auth/email-change';
import { emailedLinkIdentifier } from '../src/features/auth/emailed-link-token';
import { requireTestServices } from '@offense-demo/config';

/**
 * Stage 5 review follow-ups for AUTH-5.6: expired verification tokens and
 * the atomic other-session revocation, split from
 * `auth-email-change.integration.ts` to keep each file under the lint's
 * line limit.
 */
requireTestServices(process.env);
setupRitewayBun();

const flows = await createPasskeyFlows();
const { signUp } = flows.account;

describe('AUTH-5.6 change the recovery email: expiry and atomic revocation', () => {
  test('an expired verification token is rejected server-side and changes nothing', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const expired = await flows.confirmedEmailChange(cookie);
    // The real row the real request stored, expired in place: only the
    // expiry differs from the fresh change that follows.
    await withSql(
      (sql) =>
        sql`UPDATE verification SET expires_at = now() - interval '1 minute' WHERE identifier = ${emailedLinkIdentifier('email-change-verify', expired.verifyToken)}`,
    );
    const expiredAttempt = await flows.confirmEmailPost(expired.verifyToken);
    const emailAfterExpired = await emailOf(uid);
    const expiredReplay = await flows.confirmEmailPost(expired.verifyToken);
    const fresh = await flows.confirmedEmailChange(cookie);
    const validAttempt = await flows.confirmEmailPost(fresh.verifyToken);
    assert({
      given:
        'a real email-change verification token whose stored row has expired, next to a fresh change',
      should:
        'reject the expired token, and its replay, leaving the original address, while the fresh token still succeeds',
      actual: {
        expiredStatus: expiredAttempt.status,
        emailAfterExpired,
        expiredReplayStatus: expiredReplay.status,
        validStatus: validAttempt.status,
        emailAfterValid: await emailOf(uid),
      },
      expected: {
        expiredStatus: 400,
        emailAfterExpired: email,
        expiredReplayStatus: 400,
        validStatus: 303,
        emailAfterValid: fresh.newEmail,
      },
    });
  });

  test('each hop stores only the purpose and SHA3-256 digest of an opaque token, with its subject and the configured lifetime', async () => {
    const { email, cookie } = await signUp();
    const uid = (await userIdOf(email)) ?? '';
    const { newEmail, verifyToken } = await flows.confirmedEmailChange(cookie);
    const rows = await withSql(
      (sql) =>
        sql`SELECT identifier, value, round(extract(epoch from (expires_at - created_at)))::int AS lifetime FROM verification WHERE identifier LIKE 'email-change-%' AND strpos(value, ${uid}) > 0`,
    );
    const tokenAnywhere = await withSql(
      (sql) =>
        sql`SELECT 1 FROM verification WHERE strpos(identifier, ${verifyToken}) > 0 OR strpos(value, ${verifyToken}) > 0`,
    );
    assert({
      given:
        'the second-hop token minted by the production approval (the approval row already consumed)',
      should:
        'be an opaque 256-bit token, not a JWT, stored only as its purpose-scoped SHA3-256 digest with the account, both addresses and the configured lifetime',
      actual: {
        opaque256: /^[A-Za-z0-9_-]{43}$/.test(verifyToken),
        rows: rows.map(
          (row: { identifier: string; value: string; lifetime: number }) => ({
            identifier: row.identifier,
            subject: JSON.parse(row.value),
            lifetime: row.lifetime,
          }),
        ),
        tokenStored: tokenAnywhere.length,
      },
      expected: {
        opaque256: true,
        rows: [
          {
            identifier: emailedLinkIdentifier(
              'email-change-verify',
              verifyToken,
            ),
            subject: { userId: uid, email, newEmail },
            lifetime: EMAIL_CHANGE_LINK_EXPIRES_IN_SECONDS,
          },
        ],
        tokenStored: 0,
      },
    });
  });

  test("the atomic revocation's session.revoked append commits on the exact transaction that deleted the session", async () => {
    // RT-2.2v minor 1 (NC4): a unit test cannot tell `appendOutboxEvent(tx,
    // …)` apart from `appendOutboxEvent(database, …)` in
    // `revokeOtherSessions` — an awaited append that throws aborts the
    // caller's transaction either way. This proves the positive claim
    // directly: a fixture-scoped `BEFORE DELETE` trigger on `session`,
    // firing on the exact row the atomic revocation deletes, inserts a
    // marker outbox row from *inside that same statement's transaction*.
    // `outbox.txid` defaults to `pg_current_xact_id()` (`schema/outbox.ts`),
    // so the marker and the real `session.revoked` row carry the same txid
    // only if both inserts ran on the DELETE's own connection. Mutating the
    // source to `appendOutboxEvent(database, …)` moves that insert onto a
    // separate pooled connection with its own transaction id and turns this
    // red without needing any forced failure.
    const { email, cookie } = await signUp();
    const { redeem } = flows.account.flows;
    const otherToken = await flows.account.flows.linkTokenFor(email);
    await redeem(otherToken);
    const { verifyToken } = await flows.confirmedEmailChange(cookie);

    const uid = (await userIdOf(email)) ?? '';

    const markerTopic = `test:xact-marker:${uid}`;
    const fnName = `xact_marker_${createId()}`;
    await withSql((sql) =>
      sql.unsafe(`
        create function "${fnName}"() returns trigger as $body$
        begin
          if old.user_id = '${uid}' then
            insert into outbox (topic, kind, version, payload)
            values ('${markerTopic}', 'test.xact_marker', 1, '{}'::jsonb);
          end if;
          return old;
        end;
        $body$ language plpgsql
      `),
    );
    await withSql((sql) =>
      sql.unsafe(`
        create trigger "${fnName}_trigger" before delete on session
        for each row execute function "${fnName}"()
      `),
    );

    let completion: Response;
    try {
      completion = await flows.confirmEmailPost(verifyToken);
    } finally {
      await withSql((sql) =>
        sql.unsafe(`drop trigger if exists "${fnName}_trigger" on session`),
      );
      await withSql((sql) =>
        sql.unsafe(`drop function if exists "${fnName}"()`),
      );
    }

    const [markerRow] = await withSql(
      (sql) =>
        sql`select txid::text as txid from outbox where topic = ${markerTopic}`,
    );
    const [revokedRow] = await withSql(
      (sql) =>
        sql`select txid::text as txid from outbox where topic = ${buildUserInboxTopic(uid)} and kind = 'session.revoked'`,
    );
    await withSql(
      (sql) => sql`delete from outbox where topic = ${markerTopic}`,
    );
    await withSql(
      (sql) =>
        sql`delete from outbox where topic = ${buildUserInboxTopic(uid)}`,
    );

    assert({
      given:
        "the atomic revocation's session.revoked append and a fixture trigger that marks the DELETE's own transaction",
      should:
        'complete the change and record both inserts on the exact same Postgres transaction',
      actual: {
        completionStatus: completion.status,
        markerRowFound: markerRow !== undefined,
        revokedRowFound: revokedRow !== undefined,
        sameTransaction: markerRow?.txid === revokedRow?.txid,
      },
      expected: {
        completionStatus: 303,
        markerRowFound: true,
        revokedRowFound: true,
        sameTransaction: true,
      },
    });
  });

  test('a session committed while the completion is still in flight does not survive the atomic revocation', async () => {
    const { email, cookie } = await signUp();
    const { redeem, app } = flows.account.flows;
    const concurrentToken = await flows.account.flows.linkTokenFor(email);
    const { verifyToken } = await flows.confirmedEmailChange(cookie);

    // A bare `Promise.all` race is nondeterministic about which pipeline
    // reaches the database first. ISSUE-22's CI failure was that race: when
    // the sign-in's account lookup landed after the completion had moved the
    // account off the old address, it found no account there and signed up a
    // brand-new one, whose session no revocation of this account could touch.
    // ISSUE-99 revokes links still outstanding when the change commits; a
    // link consumed in that same instant may still sign up an empty account
    // at the released address, a residual risk ADR 0025 records as accepted
    // by the owner. This test does not cover that case. It pins the interleaving
    // under test: the completion's address switch (the real transactional
    // `completeEmailChange`, only its start delayed) waits until the
    // concurrent sign-in has committed its session on this account, so the
    // revocation that follows must remove it. The database guarantee for a
    // session that commits while the revoke-all itself is in flight is
    // proven in `packages/db/integration/session-revoke-all-race.integration.ts`.
    const { database } = app;
    const realComplete = database.completeEmailChange.bind(database);
    let releaseCompletion = () => {};
    const completionMayProceed = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    database.completeEmailChange = async (input) => {
      await completionMayProceed;
      return realComplete(input);
    };
    try {
      const [concurrentSignIn, completion] = await Promise.all([
        redeem(concurrentToken).then((response) => {
          releaseCompletion();
          return response;
        }),
        flows.confirmEmailPost(verifyToken),
      ]);
      const concurrentCookie = cookieHeader(concurrentSignIn);

      assert({
        given:
          'a sign-in to the account that commits its session while the email-change completion is still in flight',
        should: 'complete the change and revoke that sign-in anyway',
        actual: {
          completionRedirected: completion.status,
          concurrentSessionIssued: concurrentCookie.length > 0,
          concurrentSessionAuthenticated:
            await flows.isAuthenticated(concurrentCookie),
        },
        expected: {
          completionRedirected: 303,
          concurrentSessionIssued: true,
          concurrentSessionAuthenticated: false,
        },
      });
    } finally {
      database.completeEmailChange = realComplete;
    }
  });
});

// ISSUE-23's forced-outbox-failure test (real DB fault, session cookie,
// header surface and logging all proven together) lives in
// auth-email-change-atomicity-fault-injection.integration.ts, split out to
// stay under this file's line limit.
