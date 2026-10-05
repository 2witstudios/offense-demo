import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createDatabase } from '@offense-demo/db';
import {
  counts,
  emptyCounts,
  isCuid2,
  removeAccount,
  withSql,
} from './fixtures';
import { createTestAuthServer } from './auth-server-harness';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

/** The subset of the Better Auth runtime adapter these records exercise. */
type AuthAdapter = {
  create: (input: {
    model: string;
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  findOne: (input: {
    model: string;
    where: { field: string; operator: string; value: unknown }[];
  }) => Promise<unknown>;
  update: (input: {
    model: string;
    where: { field: string; operator: string; value: unknown }[];
    update: Record<string, unknown>;
  }) => Promise<unknown>;
  delete: (input: {
    model: string;
    where: { field: string; operator: string; value: unknown }[];
  }) => Promise<unknown>;
};

/**
 * The runtime adapter (with create/findOne/update/delete) lives on the
 * Better Auth context bound to the same Bun SQL pool.
 */
const runtimeAdapter = async (database: ReturnType<typeof createDatabase>) => {
  const auth = createTestAuthServer(database.authAdapter, { sent: [] });
  const context = (await auth.instance.$context) as { adapter: AuthAdapter };
  return context.adapter;
};

// The subject here is durable passkey-record persistence, not a login
// journey: the owning user is a labeled test fixture row, not a session.
const createFixtureUser = async () => {
  const userId = createId();
  await withSql(
    (sql) =>
      sql`insert into users (id, username, email, email_verified, name) values (${userId}, ${`passkey-${userId}`}, null, false, '')`,
  );
  return userId;
};

/** The SQLSTATE a rejected write carries (the driver error is the cause). */
const sqlStateOf = (write: Promise<unknown>) =>
  write.then(
    () => 'accepted',
    (error: { errno?: string; cause?: { errno?: string } }) =>
      error.cause?.errno ?? error.errno ?? 'unknown',
  );

const passkeyData = (userId: string, credentialID: string) => ({
  name: 'Laptop',
  publicKey: `pk-${createId()}${createId()}`,
  userId,
  credentialID,
  counter: 0,
  deviceType: 'singleDevice',
  backedUp: false,
  transports: 'internal',
});

test('passkey records round-trip through the Better Auth adapter on the shared pool', async () => {
  const database = createDatabase({ url });
  const adapter = await runtimeAdapter(database);
  const userId = await createFixtureUser();
  try {
    const credentialId = `cred-${createId()}${createId()}`;
    const passkey = (await adapter.create({
      model: 'passkey',
      data: passkeyData(userId, credentialId),
    })) as { id: string; credentialID: string; userId: string };
    const found = (await adapter.findOne({
      model: 'passkey',
      where: [{ field: 'credentialID', operator: 'eq', value: credentialId }],
    })) as { id: string } | null;
    const renamed = (await adapter.update({
      model: 'passkey',
      where: [{ field: 'id', operator: 'eq', value: passkey.id }],
      update: { name: 'Roaming key' },
    })) as { name: string } | null;
    assert({
      given: 'a passkey record created through the auth adapter',
      should: 'be retrievable by credential and renamable in place',
      actual: {
        cuid2Id: isCuid2(passkey.id),
        owner: passkey.userId,
        foundByCredential: found?.id,
        renamed: renamed?.name,
      },
      expected: {
        cuid2Id: true,
        owner: userId,
        foundByCredential: passkey.id,
        renamed: 'Roaming key',
      },
    });

    assert({
      given: 'a duplicate credential and a credential for an unknown owner',
      should: 'reject with the unique violation and the foreign-key violation',
      actual: {
        duplicate: await sqlStateOf(
          adapter.create({
            model: 'passkey',
            data: passkeyData(userId, credentialId),
          }),
        ),
        unknownOwner: await sqlStateOf(
          adapter.create({
            model: 'passkey',
            data: passkeyData(createId(), `cred-${createId()}${createId()}`),
          }),
        ),
      },
      expected: { duplicate: '23505', unknownOwner: '23503' },
    });

    await adapter.delete({
      model: 'passkey',
      where: [{ field: 'id', operator: 'eq', value: passkey.id }],
    });
    const gone = await adapter.findOne({
      model: 'passkey',
      where: [{ field: 'id', operator: 'eq', value: passkey.id }],
    });
    assert({
      given: 'removal of an owned passkey record',
      should: 'delete durably so neither the adapter nor storage finds it',
      actual: {
        goneAfterDelete: gone,
        passkeys: (await counts({ userId })).passkeys,
      },
      expected: { goneAfterDelete: null, passkeys: 0 },
    });
  } finally {
    await removeAccount({ userId });
    await database.close();
  }

  assert({
    given: 'the bounded fixture cleanup after the passkey round trip',
    should: 'leave no fixture records behind',
    actual: await counts({ userId }),
    expected: emptyCounts,
  });
});
