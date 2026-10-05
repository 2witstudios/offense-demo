import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

/**
 * ISSUE-8 AC4: `bun db:seed` writes dev and demo content only through
 * `@offense-demo/db`'s adapter operations. The seed's behaviour is proven against
 * PostgreSQL by `packages/db/integration/seed.integration.test.ts`; this
 * guards the one rule a behaviour test cannot see, that the script holds no
 * driver or SQL of its own.
 */
describe('db:seed entry point', () => {
  test('writes only through the adapter: no driver, no ORM, no SQL text', async () => {
    const source = await Bun.file(new URL('./seed.ts', import.meta.url)).text();
    assert({
      given: 'the db:seed entry point source',
      should:
        'import the adapter seed operation and no database driver, ORM or SQL statement',
      actual: {
        adapter: source.includes("from '@offense-demo/db/dev-seed'"),
        driver: /from ['"](bun|postgres|pg|drizzle-orm[^'"]*)['"]/.test(source),
        sql: /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i.test(
          source,
        ),
      },
      expected: { adapter: true, driver: false, sql: false },
    });
  });
});
