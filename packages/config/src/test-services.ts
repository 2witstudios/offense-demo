import { z } from 'zod';
import {
  expectedTestRedisDatabase,
  testRedisRefusal,
  type OwnTestRedisUrl,
} from './test-redis';
import { testDatabaseRefusal } from './test-database';
import { databaseUrl, redisUrl } from './urls';

type TestServices = {
  readonly databaseUrl: string;
  readonly redisUrl: OwnTestRedisUrl;
};

/**
 * Both readers share the Redis rule (ISSUE-245): TEST_REDIS_URL must be this
 * slot's own database on the server REDIS_URL names, so a suite or the runner
 * started against another slot's, dev's or e2e's Redis is refused before it
 * writes or deletes a key. Only the database rule differs.
 */
const testServicesSchema = (
  databaseRule: z.ZodType<string>,
  kind: 'slot' | 'run',
) =>
  z
    .object({
      TEST_DATABASE_URL: databaseRule,
      TEST_REDIS_URL: redisUrl,
      DATABASE_URL: z.string().optional(),
      TEST_RUN_DATABASE: z.string().optional(),
      REDIS_URL: z.string().optional(),
      PORT: z.string().optional(),
    })
    .superRefine((env, ctx) => {
      const database = testDatabaseRefusal({
        kind,
        testDatabaseUrl: env.TEST_DATABASE_URL,
        databaseUrl: env.DATABASE_URL,
        runDatabase: env.TEST_RUN_DATABASE,
      });
      if (database)
        ctx.addIssue({
          code: 'custom',
          path: ['TEST_DATABASE_URL'],
          message: database,
        });
      const message = testRedisRefusal({
        testRedisUrl: env.TEST_REDIS_URL,
        redisUrl: env.REDIS_URL,
        expected: expectedTestRedisDatabase(env.PORT),
      });
      if (message)
        ctx.addIssue({ code: 'custom', path: ['TEST_REDIS_URL'], message });
    });
const readTestServices = (
  schema: ReturnType<typeof testServicesSchema>,
  env: Record<string, string | undefined>,
): TestServices => {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Integration suites require isolated test services: ${result.error.issues
        .map((issue) =>
          issue.code === 'custom'
            ? `${issue.path.join('.')} (${issue.message})`
            : issue.path.join('.'),
        )
        .join(', ')}`,
    );
  return {
    databaseUrl: result.data.TEST_DATABASE_URL,
    redisUrl: result.data.TEST_REDIS_URL as OwnTestRedisUrl,
  };
};
const runDatabaseSchema = testServicesSchema(databaseUrl, 'run');
const slotDatabaseSchema = testServicesSchema(databaseUrl, 'slot');
/**
 * The one guard every integration suite calls (ISSUE-11; `bun evidence`
 * checks each suite imports it). A missing or non-test service throws,
 * naming the fields and never their values: a suite never skips. The
 * database must be the one the runner made for this run, so a suite started
 * by hand against the slot database is refused rather than left to leak rows
 * (ISSUE-238), and the Redis URL must be this slot's own database on its own
 * server (ISSUE-245).
 */
export function requireTestServices(
  env: Record<string, string | undefined>,
): TestServices {
  return readTestServices(runDatabaseSchema, env);
}
/** The runner's view (ISSUE-238): the slot's `_test` database its per-run databases derive from, with the same Redis rule. */
export function requireTestSlotServices(
  env: Record<string, string | undefined>,
): TestServices {
  return readTestServices(slotDatabaseSchema, env);
}
