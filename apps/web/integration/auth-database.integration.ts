import { SQL } from 'bun';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import {
  counts,
  emptyCounts,
  fixtureEmail,
  isCuid2,
  linkFrom,
  removeAccount,
  tokenOf,
} from './fixtures';
import { emailedLinkRejected } from './auth-account-helpers';
import {
  createDatabaseAuthServer,
  createTestAuthServer,
  redeemMagicLink,
  type SentMessages,
} from './auth-server-harness';
import {
  logsLeakSecrets,
  type RecordedLogs,
} from '../src/features/auth/log-leaks';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

const isDate = (value: unknown): value is Date => value instanceof Date;

type RunContext = {
  auth: ReturnType<typeof createTestAuthServer>;
  email: string;
  sent: SentMessages;
  logged: RecordedLogs;
  setUserId: (id: string) => void;
};

/** Runs one auth server over the shared pool and cleans only its fixtures. */
const runAuth = async (body: (context: RunContext) => Promise<void>) => {
  const email = fixtureEmail();
  const { sent, logged, database, auth } = createDatabaseAuthServer(url);
  let userId: string | undefined;
  try {
    await body({
      auth,
      email,
      sent,
      logged,
      setUserId: (id) => {
        userId = id;
      },
    });
  } finally {
    await database.close();
    await removeAccount({ email, userId });
  }
  return { email, userId, logged };
};

test('magic-link request persists a token-bearing verification record', async () => {
  const { email } = await runAuth(async ({ auth, email, sent }) => {
    const result = await auth.instance.api.signInMagicLink({
      body: { email },
      headers: new Headers({ origin: auth.config.PUBLIC_APP_URL }),
    });
    assert({
      given: 'a magic-link request using the existing Bun SQL pool',
      should: 'succeed and send one account-neutral message',
      actual: {
        status: result.status,
        sent: sent.map(({ to, subject }) => ({ to, subject })),
      },
      expected: {
        status: true,
        sent: [{ to: email, subject: 'Sign in to Offense Demo' }],
      },
    });

    const probe = new SQL(url);
    try {
      // Better Auth stamps expires_at and created_at from one clock in one
      // call, so their difference is the link lifetime with no wall clock.
      const rows = await probe.unsafe(
        `select identifier, value,
           round(extract(epoch from (expires_at - created_at)))::int as lifetime_seconds
         from verification where strpos(value, $1) > 0`,
        [email],
      );
      assert({
        given: 'the durable verification record after requesting a link',
        should:
          'carry the account in value, a token (not the email) in identifier, and a five-minute lifetime',
        actual: rows.map(
          (row: {
            identifier: string;
            value: string;
            lifetime_seconds: number;
          }) => ({
            value: JSON.parse(row.value),
            identifierIsNotTheEmail: row.identifier !== email,
            lifetimeSeconds: row.lifetime_seconds,
          }),
        ),
        expected: [
          {
            value: { email },
            identifierIsNotTheEmail: true,
            lifetimeSeconds: 300,
          },
        ],
      });
    } finally {
      await probe.close();
    }
  });

  assert({
    given: 'the bounded fixture cleanup after the request',
    should: 'leave no fixture records behind',
    actual: await counts(email),
    expected: emptyCounts,
  });
});

type SessionView = {
  user: { id: string; email: string; emailVerified: boolean };
  session: { id: string; token: string; expiresAt: unknown };
} | null;

const sessionBoundary = (
  row: { id: string; expires_at: Date; token: string } | undefined,
  view: SessionView,
) => ({
  exists: row !== undefined,
  sameSession: row?.id === view?.session.id,
  rowExpiresAtIsDate: isDate(row?.expires_at),
  isoRoundTrip: isDate(row?.expires_at)
    ? new Date(view?.session.expiresAt as string).toISOString() ===
      row.expires_at.toISOString()
    : false,
  cookieTokenMatchesRow: row?.token === view?.session.token,
});

const probeSessionRow = async (userId: string) => {
  const probe = new SQL(url);
  try {
    const rows = await probe.unsafe(
      'select id, expires_at, token from session where user_id = $1',
      [userId],
    );
    return rows[0] as
      { id: string; expires_at: Date; token: string } | undefined;
  } finally {
    await probe.close();
  }
};

const probeSessionIds = async (userId: string) => {
  const probe = new SQL(url);
  try {
    return (await probe.unsafe('select id from session where user_id = $1', [
      userId,
    ])) as { id: string }[];
  } finally {
    await probe.close();
  }
};

/** Redeems the captured link and asserts it answered with a fresh session. */
const redeemAndAssertSession = async (
  auth: RunContext['auth'],
  token: string,
  email: string,
  setUserId: RunContext['setUserId'],
) => {
  // Redeem the way a person does: POST to the same-origin confirm page,
  // which forwards into Better Auth internally (ISSUE-3: a direct GET to
  // /api/auth/magic-link/verify is refused by the mounted route).
  const redemption = await redeemMagicLink(auth, token);
  const sessionCookie = redemption.headers.get('set-cookie')?.split(';')[0];
  const sessionView = (await auth.instance.api.getSession({
    headers: new Headers({ cookie: sessionCookie ?? '' }),
  })) as SessionView;
  setUserId(sessionView?.user.id ?? '');
  assert({
    given: 'redemption of the captured magic link through the confirm page',
    should: 'create a verified cuid2 user whose cookie resolves durably',
    actual: {
      status: redemption.status,
      location: redemption.headers.get('location'),
      email: sessionView?.user.email,
      emailVerified: sessionView?.user.emailVerified,
      cuid2Id: isCuid2(sessionView?.user.id ?? ''),
      cookieIssued: typeof sessionCookie === 'string',
    },
    expected: {
      status: 303,
      // A brand-new account redirects to onboarding, not the plain
      // callbackURL (Better Auth's magic-link plugin picks
      // newUserCallbackURL for a first-time sign-in).
      location: '/onboarding/username',
      email,
      emailVerified: true,
      cuid2Id: true,
      cookieIssued: true,
    },
  });
  return sessionView;
};

/** Asserts the durable session row agrees with the get-session response. */
const assertDurableSessionRow = async (sessionView: SessionView) => {
  const row = await probeSessionRow(sessionView?.user.id ?? '');
  assert({
    given: 'the durable session row and the get-session response',
    should: 'agree on identity and the Date/ISO timestamp boundary',
    actual: sessionBoundary(row, sessionView),
    expected: {
      exists: true,
      sameSession: true,
      rowExpiresAtIsDate: true,
      isoRoundTrip: true,
      cookieTokenMatchesRow: true,
    },
  });
};

/** Replays the consumed token and asserts it authenticates no second time. */
const assertReplayRejected = async (
  auth: RunContext['auth'],
  token: string,
  sessionView: SessionView,
) => {
  const replay = await redeemMagicLink(auth, token);
  assert({
    given: 'a replayed verification token through the confirm page',
    should: 'authenticate no second time',
    actual: { rejected: emailedLinkRejected(replay) },
    expected: { rejected: true },
  });

  const persistedSessions = await probeSessionIds(sessionView?.user.id ?? '');
  assert({
    given: 'the persisted sessions after the replayed token',
    should: 'keep the original session as the only authentication state',
    actual: persistedSessions.map(({ id }) => id),
    expected: [sessionView?.session.id],
  });
};

test('redeeming the captured link durably creates a verified user and session', async () => {
  const { email, userId } = await runAuth(
    async ({ auth, email, sent, logged, setUserId }) => {
      await auth.instance.api.signInMagicLink({
        body: { email },
        headers: new Headers({ origin: auth.config.PUBLIC_APP_URL }),
      });
      // Fail loudly here rather than redeeming a token parsed from nothing.
      assert({
        given: 'the magic-link request',
        should: 'capture exactly one outbound message to redeem',
        actual: sent.length,
        expected: 1,
      });
      const token = tokenOf(linkFrom(sent[0]!));

      const sessionView = await redeemAndAssertSession(
        auth,
        token,
        email,
        setUserId,
      );
      await assertDurableSessionRow(sessionView);
      await assertReplayRejected(auth, token, sessionView);

      assert({
        given: 'the integration run with its captured logger',
        should:
          'capture the mail delivery log entry and never log token or email material',
        actual: {
          events: logged.map(([event]) => event),
          leaks: logsLeakSecrets(logged, [token, email]),
        },
        expected: { events: ['auth.mail.sent'], leaks: false },
      });
    },
  );

  assert({
    given: 'the bounded fixture cleanup after the completed round trip',
    should: 'leave no user, session or verification records behind',
    actual: await counts({ email, userId }),
    expected: emptyCounts,
  });
});
