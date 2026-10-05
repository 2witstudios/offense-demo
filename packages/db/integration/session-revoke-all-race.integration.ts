import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createDatabase } from '../src/index';
import { finishedOrBlockedBehind } from '../src/testing';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

const insertSession = (sql: SQL, userId: string, token: string) =>
  sql.unsafe(
    `insert into session (id, token, user_id, expires_at)
     values ($1, $2, $3, now() + interval '1 day')`,
    [createId(), token, userId],
  );

test('ISSUE-22: a session inserted while a revoke-all is in flight never survives it', async () => {
  const userId = createId();
  const keepToken = `keep-${createId()}`;
  const racingToken = `racing-${createId()}`;
  const setup = new SQL(url, { max: 1 });
  const inserter = new SQL(url, { max: 1 });
  const observer = new SQL(url, { max: 1 });
  const database = createDatabase({ url });
  try {
    await setup.unsafe('insert into users (id, email) values ($1, $2)', [
      userId,
      `${userId}@example.test`,
    ]);
    await insertSession(setup, userId, keepToken);

    // The interleaving that lost the race in CI (ISSUE-22): a sign-in's
    // session row is written but not yet committed when the revoke-all
    // starts, so a DELETE snapshot taken now cannot see it, and it commits
    // while the revoke-all is still in flight.
    await inserter.unsafe('begin');
    await insertSession(inserter, userId, racingToken);
    const [{ pid: inserterPid }] = (await inserter.unsafe(
      'select pg_backend_pid() as pid',
    )) as [{ pid: number }];

    const revoke = database.revokeOtherSessions(userId, keepToken);
    // Either the revoke finishes without waiting (the race is open) or the
    // database reports it blocked behind the uncommitted insert; only then
    // does the insert commit. No sleep decides the order.
    const firstOutcome = await finishedOrBlockedBehind(
      revoke,
      observer,
      inserterPid,
      { now: Date.now },
    );
    await inserter.unsafe('commit');
    const removed = await revoke;

    const survivors = await setup.unsafe(
      'select token from session where user_id = $1 order by token',
      [userId],
    );
    assert({
      given:
        'a session insert that commits while revokeOtherSessions is in flight for the same user',
      should:
        'serialize the two: the revoke waits for the insert, then deletes it, keeping only the kept session',
      actual: {
        firstOutcome,
        removed,
        survivors: survivors.map((row: { token: string }) => row.token),
      },
      expected: {
        firstOutcome: 'blocked',
        removed: 1,
        survivors: [keepToken],
      },
    });
  } finally {
    await inserter.unsafe('rollback').catch(() => {});
    // The revoke appended session.revoked to this user's inbox topic.
    await setup.unsafe('delete from outbox where topic = $1', [
      `user:${userId}:inbox`,
    ]);
    await setup.unsafe('delete from users where id = $1', [userId]);
    await Promise.allSettled([
      setup.close(),
      inserter.close(),
      observer.close(),
      database.close(),
    ]);
  }
});
