import { SQL } from 'bun';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { buildUserInboxTopic } from '@offense-demo/protocol';
import { withOutboxInsertBlockedForTopic } from './auth-outbox-helpers';
import { fixtureEmail, linkFrom, removeAccount, tokenOf } from './fixtures';
import {
  createDatabaseAuthServer,
  createTestAuthServer,
  redeemMagicLink,
  type SentMessages,
} from './auth-server-harness';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

const signInOnce = async (
  auth: ReturnType<typeof createTestAuthServer>,
  email: string,
  sent: SentMessages,
) => {
  await auth.instance.api.signInMagicLink({
    body: { email },
    headers: new Headers({ origin: auth.config.PUBLIC_APP_URL }),
  });
  const token = tokenOf(linkFrom(sent.at(-1)!));
  const response = await redeemMagicLink(auth, token);
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  // Read on the server through auth.api: browser responses carry no session
  // token (ISSUE-63).
  const body = await auth.instance.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true },
  });
  return {
    cookie,
    userId: body?.user?.id ?? '',
    sessionToken: body?.session?.token ?? '',
  };
};

const sessionExists = async (admin: SQL, token: string): Promise<boolean> => {
  const rows = await admin.unsafe('select 1 from session where token = $1', [
    token,
  ]);
  return rows.length > 0;
};

/**
 * RT-2.2v nit: a real-fault forced-failure proof for every self-service
 * revoke endpoint. `/revoke-session` is Better Auth's own delete, so its
 * doorbell is the best-effort `sessionRevokedOutboxPlugin` append: a failure
 * never fails the call. `/revoke-other-sessions` and `/revoke-sessions` are
 * Offense Demo's serialized revoke-all (ISSUE-22, `revoke-sessions.ts`), whose
 * append shares the DELETE's transaction (ADR 0032 §5): a failure rolls the
 * whole revocation back and the call reports the outage.
 */
const routes: readonly {
  readonly path: string;
  readonly atomic: boolean;
  readonly body: (secondToken: string) => string;
}[] = [
  { path: '/revoke-other-sessions', atomic: true, body: () => '{}' },
  { path: '/revoke-sessions', atomic: true, body: () => '{}' },
  {
    path: '/revoke-session',
    atomic: false,
    body: (secondToken) => JSON.stringify({ token: secondToken }),
  },
];

for (const route of routes) {
  test(`a forced outbox failure on a real ${route.path} call ${route.atomic ? 'rolls the whole revocation back' : 'never fails it, and logs the registered event'}`, async () => {
    const email = fixtureEmail();
    const { sent, logged, database, auth } = createDatabaseAuthServer(
      url,
      (pool) => ({
        appendSessionRevoked: (userId) => pool.appendSessionRevoked(userId),
      }),
    );
    const admin = new SQL(url);
    let userId: string | undefined;
    try {
      const first = await signInOnce(auth, email, sent);
      userId = first.userId;
      const second = await signInOnce(auth, email, sent);
      const inbox = buildUserInboxTopic(first.userId);

      let response: Response | undefined;
      let failureCode: unknown;
      await withOutboxInsertBlockedForTopic(inbox, async () => {
        response = await auth.instance
          .handler(
            new Request(`${auth.config.PUBLIC_APP_URL}/api/auth${route.path}`, {
              method: 'POST',
              headers: new Headers({
                origin: auth.config.PUBLIC_APP_URL,
                cookie: first.cookie,
                'content-type': 'application/json',
              }),
              body: route.body(second.sessionToken),
            }),
          )
          .catch((error: { code?: unknown }) => {
            failureCode = error.code;
            return undefined;
          });
      });

      const outboxRows = await admin.unsafe(
        'select 1 from outbox where topic = $1',
        [inbox],
      );

      assert({
        given: `a real ${route.path} call while its topic's outbox insert is forced to fail`,
        should: route.atomic
          ? 'report the outage and keep the target session: the append and the DELETE commit together or not at all'
          : 'still deny the target session and answer success, appending nothing and logging the registered failure event instead of throwing',
        actual: {
          status: response?.status,
          failureCode,
          secondSessionDenied: !(await sessionExists(
            admin,
            second.sessionToken,
          )),
          outboxRowsAppended: outboxRows.length,
          loggedAppendFailure: logged.some(
            ([event]) => event === 'realtime.outbox.append_failed',
          ),
        },
        expected: route.atomic
          ? {
              status: undefined,
              failureCode: 'INFRASTRUCTURE',
              secondSessionDenied: false,
              outboxRowsAppended: 0,
              loggedAppendFailure: false,
            }
          : {
              status: 200,
              failureCode: undefined,
              secondSessionDenied: true,
              outboxRowsAppended: 0,
              loggedAppendFailure: true,
            },
      });
    } finally {
      await database.close();
      await admin.close();
      await removeAccount({ email, userId });
    }
  });
}

const insertOutboxRow = (admin: SQL, topic: string) =>
  admin
    .unsafe(
      "insert into outbox (topic, kind, version, payload) values ($1, 'test.scope-check', 1, '{}'::jsonb)",
      [topic],
    )
    .then(() => 'accepted')
    .catch(() => 'refused');

/**
 * RT-2.2f-r1 minor: nothing enforced that `withOutboxInsertBlockedForTopic`'s
 * `BEFORE INSERT` trigger only rejects its own topic — if the `if new.topic
 * = …` guard were ever dropped, every other test using the helper would
 * still pass (they only insert on their own already-blocked topic), and
 * nothing would notice.
 */
test('withOutboxInsertBlockedForTopic blocks only its own topic, never an unrelated one', async () => {
  const admin = new SQL(url);
  const blockedTopic = `test:scope-check:${createId()}`;
  const otherTopic = `test:scope-check:${createId()}`;
  try {
    let blockedAttempt = '';
    let otherAttempt = '';
    await withOutboxInsertBlockedForTopic(blockedTopic, async () => {
      blockedAttempt = await insertOutboxRow(admin, blockedTopic);
      otherAttempt = await insertOutboxRow(admin, otherTopic);
    });
    assert({
      given: "a BEFORE INSERT trigger held for one fixture's own topic",
      should:
        'refuse an insert on that exact topic while an insert on an unrelated topic still succeeds',
      actual: { blockedAttempt, otherAttempt },
      expected: { blockedAttempt: 'refused', otherAttempt: 'accepted' },
    });
  } finally {
    await admin.unsafe('delete from outbox where topic = $1', [otherTopic]);
    await admin.close();
  }
});
