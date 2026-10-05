import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createDatabase } from '../src';
import { withFixture } from './constraint-helpers';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

const projects = { kind: 'projects' } as const;

describe('loadAuthorizationContext (ADR 0048 section 5)', () => {
  test('reads the account-erased fact from users.deleted_at as the web runtime role', async () => {
    await withFixture(url, async (fixture) => {
      const live = await fixture.user();
      const erased = createId();
      await fixture.insert('users', {
        id: erased,
        username: null,
        email: null,
        name: '',
        deleted_at: new Date('2026-01-01T00:00:00.000Z'),
      });
      // One connection, switched to offense_demo_web, so every read runs with
      // exactly the web runtime role's privileges.
      const client = new SQL(url, { max: 1 });
      const database = createDatabase({ url, client });
      try {
        await client.unsafe('set role offense_demo_web');
        const load = (userId: string | null) =>
          database.loadAuthorizationContext({ userId, resourceRef: projects });
        assert({
          given:
            'a live account, a tombstoned account, an unknown id and an anonymous visitor',
          should:
            'report account-erased for the tombstone and the unknown id only',
          actual: {
            live: await load(live),
            erased: await load(erased),
            unknown: await load(createId()),
            anonymous: await load(null),
          },
          expected: {
            live: { resource: projects, accountErased: false },
            erased: { resource: projects, accountErased: true },
            unknown: { resource: projects, accountErased: true },
            anonymous: { resource: projects, accountErased: false },
          },
        });
      } finally {
        await database.close();
      }
    });
  });
});
