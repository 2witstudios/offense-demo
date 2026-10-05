import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { createDatabase } from '../src';
import { withFixture, type Fixture } from './constraint-helpers';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/** A provisional user: signed up, no username yet. */
const provisionalUser = async (fixture: Fixture) => {
  const userId = createId();
  await fixture.insert('users', { id: userId, username: null });
  return userId;
};

const userRow = async (fixture: Fixture, userId: string) => {
  const [row] = (await fixture.sql.unsafe(
    'select username, name, version from users where id = $1',
    [userId],
  )) as Array<{ username: string | null; name: string; version: number }>;
  return row;
};

describe('claimUsername (server-owned onboarding)', () => {
  test('a claim sets the username and users.name and bumps the version (ISSUE-167)', async () => {
    await withFixture(url, async (fixture) => {
      const userId = await provisionalUser(fixture);
      const database = createDatabase({ url });
      const username = `named-${userId}`;
      try {
        const outcome = await database.claimUsername({ userId, username });
        assert({
          given:
            "a provisional user (name defaults to '') completing username onboarding",
          should:
            'answer claimed and store the username, the same name and version 2',
          actual: [outcome.kind, await userRow(fixture, userId)],
          expected: ['claimed', { username, name: username, version: 2 }],
        });
      } finally {
        await database.close();
      }
    });
  });

  test('a retry by the owner is unchanged, any other name is already-set', async () => {
    await withFixture(url, async (fixture) => {
      const userId = await provisionalUser(fixture);
      const database = createDatabase({ url });
      const username = `retry-${userId}`;
      try {
        await database.claimUsername({ userId, username });
        const retry = await database.claimUsername({
          userId,
          username: username.toUpperCase(),
        });
        const other = await database.claimUsername({
          userId,
          username: `other-${userId}`,
        });
        assert({
          given:
            'a claimed user claiming the same name (any case), then another',
          should: 'answer unchanged, then already-set, leaving the first name',
          actual: [
            retry.kind,
            other.kind,
            (await userRow(fixture, userId))?.username,
          ],
          expected: ['unchanged', 'already-set', username],
        });
      } finally {
        await database.close();
      }
    });
  });

  test('concurrent claims of one name, differing only in case, produce exactly one winner', async () => {
    await withFixture(url, async (fixture) => {
      const first = await provisionalUser(fixture);
      const second = await provisionalUser(fixture);
      const database = createDatabase({ url, maxConnections: 2 });
      const name = `race-${createId()}`;
      try {
        const outcomes = await Promise.all([
          database.claimUsername({ userId: first, username: name }),
          database.claimUsername({
            userId: second,
            username: name.toUpperCase(),
          }),
        ]);
        const names = [
          (await userRow(fixture, first))?.username ?? null,
          (await userRow(fixture, second))?.username ?? null,
        ];
        assert({
          given: 'two provisional users claiming the same name at once',
          should:
            'let exactly one claim win (claimed) and refuse the other (taken), changing nothing for the loser',
          actual: {
            kinds: outcomes.map(({ kind }) => kind).sort(),
            stored: names.filter((value) => value !== null).length,
          },
          expected: { kinds: ['claimed', 'taken'], stored: 1 },
        });
      } finally {
        await database.close();
      }
    });
  });

  test('an unknown user is reported, not created', async () => {
    const database = createDatabase({ url });
    try {
      const outcome = await database.claimUsername({
        userId: createId(),
        username: `ghost-${createId()}`,
      });
      assert({
        given: 'a claim for a user id with no row',
        should: 'answer unknown-user',
        actual: outcome.kind,
        expected: 'unknown-user',
      });
    } finally {
      await database.close();
    }
  });
});
