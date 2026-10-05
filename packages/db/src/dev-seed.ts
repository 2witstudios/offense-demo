import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { sql } from 'drizzle-orm';
import { seedVersions } from './schema/seed-versions';
import { users } from './schema/users';

/**
 * Dev and demo content for `bun db:seed` (ISSUE-8 AC4): fixed-id people.
 * Reference data every environment needs is not seed content; the
 * migrations insert it (ADR 0038). A product adds its own seeded rows here,
 * upserted in the same transaction so a reseed stays idempotent.
 */
export type DevSeed = {
  /** The `seed_versions` row that records which content was applied. */
  readonly name: string;
  readonly version: string;
  readonly people: ReadonlyArray<{
    readonly userId: string;
    readonly username: string;
    /** AUTH-7.6's restore rehearsal seed: a verified email, absent by default. */
    readonly email?: string;
    readonly emailVerified?: boolean;
  }>;
};

/**
 * Applies a dev seed in one transaction, idempotently: rerunning leaves
 * every seeded row byte-identical. The version
 * marker's `updated_at` moves only when the version changes. This is the
 * only path `bun db:seed` writes through; it is not part of
 * `createDatabase()`, because no running application seeds.
 */
export async function applyDevSeed({
  url,
  seed,
}: {
  readonly url: string;
  readonly seed: DevSeed;
}): Promise<void> {
  const client = new SQL(url, { max: 1 });
  try {
    await drizzle({ client }).transaction(async (tx) => {
      for (const person of seed.people) {
        await tx
          .insert(users)
          .values({
            id: person.userId,
            username: person.username,
            email: person.email ?? null,
            emailVerified: person.emailVerified ?? false,
          })
          .onConflictDoUpdate({
            target: users.id,
            set: {
              username: sql`excluded.username`,
              // A seed entry that omits email/emailVerified must not wipe a
              // value an earlier run (or another writer) already set: only
              // overwrite the column this entry actually specifies, never
              // force it back to null/false on every reseed.
              email:
                person.email === undefined ? users.email : sql`excluded.email`,
              emailVerified:
                person.emailVerified === undefined
                  ? users.emailVerified
                  : sql`excluded.email_verified`,
            },
          });
      }
      await tx
        .insert(seedVersions)
        .values({ seedName: seed.name, version: seed.version })
        .onConflictDoUpdate({
          target: seedVersions.seedName,
          set: {
            version: sql`excluded.version`,
            updatedAt: sql`case when ${seedVersions.version} <> excluded.version then excluded.updated_at else ${seedVersions.updatedAt} end`,
          },
        });
    });
  } finally {
    await client.close();
  }
}
