import { spyOn } from 'bun:test';
import { createId } from '@paralleldrive/cuid2';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { createDatabase } from '@offense-demo/db';
import type { RecordedLogs } from '../src/features/auth/log-leaks';
import { createAuthRouteHandlers } from '../src/features/auth/handlers';
import { counts, emptyCounts, fixtureEmail, removeAccount } from './fixtures';
import { createTestAuthServer, type SentMessages } from './auth-server-harness';
import { requireTestServices } from '@offense-demo/config';

setupRitewayBun();

const { databaseUrl: url } = requireTestServices(process.env);

type ReportedFailure = { event: string; fields: unknown; message: string };

test('delivery failure surfaces a safe retryable error and cleanup still leaves no fixture rows', async () => {
  const email = fixtureEmail();
  const sent: SentMessages = [];
  const database = createDatabase({ url });
  const auth = createTestAuthServer(database.authAdapter, {
    sent,
    deliveryFailure: new Error('resend unavailable'),
  });
  try {
    let caught: unknown;
    try {
      await auth.instance.api.signInMagicLink({
        body: { email },
        headers: new Headers({ origin: auth.config.PUBLIC_APP_URL }),
      });
    } catch (error) {
      caught = error;
    }
    assert({
      given: 'an email delivery failure during a magic-link request',
      should:
        'surface a safe retryable 503 (EMAIL_DELIVERY_FAILED) without leaking the cause',
      actual: {
        status: (caught as { statusCode?: number } | undefined)?.statusCode,
        code: (caught as { body?: { code?: string } } | undefined)?.body?.code,
        leaks:
          caught !== undefined &&
          JSON.stringify(caught).includes('resend unavailable'),
      },
      expected: { status: 503, code: 'EMAIL_DELIVERY_FAILED', leaks: false },
    });
  } finally {
    await database.close();
    // No user id exists on this failed path; verification rows may exist.
    await removeAccount(email);
  }

  assert({
    given: 'the bounded fixture cleanup after the failed request',
    should: 'leave no verification or user fixture records behind',
    actual: await counts(email),
    expected: emptyCounts,
  });
});

test('pool lifecycle closes and the app failure boundary reports without SQL material', async () => {
  const failures: ReportedFailure[] = [];
  const database = createDatabase({
    url,
    maxConnections: 1,
    eventSink: (event, fields, message) =>
      failures.push({ event, fields, message }),
  });
  // The raw driver error embeds SQL and bound parameters; the app-owned
  // boundary must report only safe operation names. PostgreSQL refuses a NUL
  // byte in text, so this insert fails inside the driver itself.
  let driverRejected = false;
  try {
    await database.recordEmailDelivery({
      providerMessageId: `msg\u0000${createId()}`,
      recipientHash: createId(),
      at: '2026-01-01T00:00:00.000Z',
    });
  } catch {
    driverRejected = true;
  }
  const reportedAfterOperation = [...failures];
  const healthy = await database.health();
  await database.close();
  let closed = false;
  try {
    await database.health();
  } catch {
    closed = true;
  }

  assert({
    given: 'the shared database pool',
    should: 'report health while open and fail after the lifecycle close',
    actual: { healthy, closed },
    expected: { healthy: true, closed: true },
  });
  assert({
    given: 'a driver failure inside an application database operation',
    should:
      'reject and report only safe operation names, never SQL or parameters',
    actual: {
      driverRejected,
      reported: reportedAfterOperation.map(({ event, fields, message }) => ({
        event,
        fields,
        message,
      })),
    },
    expected: {
      driverRejected: true,
      reported: [
        {
          event: 'db.query.failed',
          fields: { operation: 'recordEmailDelivery' },
          message: 'Database query failed',
        },
      ],
    },
  });
});

test('a persistence failure inside Better Auth leaks no SQL, parameters, token or email', async () => {
  const email = fixtureEmail();
  const recorded: RecordedLogs = [];
  const database = createDatabase({ url });
  const auth = createTestAuthServer(database.authAdapter, {
    sent: [],
    recordedLogs: recorded,
  });
  await database.close();

  const spies = (['error', 'warn', 'log', 'info'] as const).map((method) =>
    spyOn(console, method).mockImplementation(() => {}),
  );
  let status: number;
  let body: string;
  // mockRestore() clears call history, so snapshot before restoring. Errors
  // serialize to {} under JSON.stringify, so expand message and cause too.
  const expand = (value: unknown): unknown =>
    value instanceof Error
      ? {
          name: value.name,
          message: value.message,
          cause: expand(value.cause),
        }
      : value;
  let consoleCalls: unknown[] = [];
  try {
    // The mounted route (handlers.ts), not the raw composed instance: that
    // is what a real client reaches, and it is the layer that converts the
    // now-thrown INFRASTRUCTURE failure into a safe, bodiless public error.
    const handlers = createAuthRouteHandlers(
      () => ({ handler: auth.instance.handler, config: auth.config }),
      auth.logger,
    );
    const response = await handlers.POST(
      new Request(`${auth.config.PUBLIC_APP_URL}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: auth.config.PUBLIC_APP_URL,
        },
        body: JSON.stringify({ email }),
      }),
    );
    status = response.status;
    body = await response.text();
  } finally {
    consoleCalls = spies.flatMap((spy) =>
      spy.mock.calls.map((c) => c.map(expand)),
    );
    for (const spy of spies) spy.mockRestore();
  }

  const emitted = JSON.stringify([consoleCalls, recorded, body]);
  assert({
    given: 'the shared pool failing during a real magic-link request',
    should:
      'fail closed with a safe retryable status and emit no SQL text, bound parameters, token or email anywhere',
    actual: {
      status,
      leaksSql: /insert into|params:|\$1/i.test(emitted),
      leaksEmail: emitted.includes(email),
      reported: recorded.length > 0 || consoleCalls.length > 0,
    },
    expected: {
      status: 503,
      leaksSql: false,
      leaksEmail: false,
      reported: true,
    },
  });
});
