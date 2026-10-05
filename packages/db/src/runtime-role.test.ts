import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  refuseSchemaAlteringRole,
  runtimeRoleFactsFrom,
  runtimeRoleProblems,
} from './runtime-role';

setupRitewayBun();

const dmlOnly = {
  superuser: false,
  create_in_public: false,
  owns_public_schema: false,
  owned_objects_in_public: 0,
};

describe('runtimeRoleProblems', () => {
  test('accepts a DML-only role', () => {
    assert({
      given: 'a role with no superuser, create, schema or object ownership',
      should: 'report nothing',
      actual: runtimeRoleProblems(runtimeRoleFactsFrom(dmlOnly)),
      expected: [],
    });
  });

  test('names each way a role could create or alter schema objects', () => {
    assert({
      given:
        'a superuser, a role with CREATE on public, the schema owner and an object owner',
      should: 'report each capability without naming the role',
      actual: [
        { ...dmlOnly, superuser: true },
        { ...dmlOnly, create_in_public: true },
        { ...dmlOnly, owns_public_schema: true },
        { ...dmlOnly, owned_objects_in_public: 3 },
      ].map((row) => runtimeRoleProblems(runtimeRoleFactsFrom(row))),
      expected: [
        ['is a superuser'],
        ['can create in schema public'],
        ['owns schema public'],
        ['owns 3 objects in schema public'],
      ],
    });
  });
});

const gateOutcome = async (
  NODE_ENV: string,
  problems: readonly string[],
  runtimeRole: 'offense_demo_web' | 'offense_demo_realtime',
) => {
  let queried = false;
  try {
    await refuseSchemaAlteringRole(
      {
        config: { NODE_ENV },
        database: {
          runtimeRoleProblems: async () => {
            queried = true;
            return problems;
          },
        },
      },
      runtimeRole,
    );
    return { queried, refused: null };
  } catch (error) {
    return { queried, refused: (error as Error).message };
  }
};

describe('refuseSchemaAlteringRole', () => {
  test('refuses a production role that can alter the schema', async () => {
    assert({
      given: 'production config and a role that owns schema public',
      should: 'refuse to start, naming the capabilities and the fix',
      actual: await gateOutcome(
        'production',
        ['can create in schema public', 'owns schema public'],
        'offense_demo_web',
      ),
      expected: {
        queried: true,
        refused:
          'Production refuses a DATABASE_URL role that can create in schema public, owns schema public; use the offense_demo_web runtime role',
      },
    });
  });

  test('names the runtime role of the service that refuses', async () => {
    assert({
      given: 'the realtime service in production as the migration owner',
      should: 'refuse to start and name offense_demo_realtime as the fix',
      actual: await gateOutcome(
        'production',
        ['owns 12 objects in schema public'],
        'offense_demo_realtime',
      ),
      expected: {
        queried: true,
        refused:
          'Production refuses a DATABASE_URL role that owns 12 objects in schema public; use the offense_demo_realtime runtime role',
      },
    });
  });

  test('starts in production as a runtime role', async () => {
    assert({
      given: 'production config and a role with no schema capability',
      should: 'start',
      actual: await gateOutcome('production', [], 'offense_demo_web'),
      expected: { queried: true, refused: null },
    });
  });

  test('never checks outside production', async () => {
    assert({
      given: 'development config running as the local owner',
      should: 'start without querying the role',
      actual: await gateOutcome(
        'development',
        ['owns schema public'],
        'offense_demo_realtime',
      ),
      expected: { queried: false, refused: null },
    });
  });
});
