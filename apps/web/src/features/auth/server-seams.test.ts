import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { memoryAdapter } from '@better-auth/memory-adapter';
import type { Logger } from '@offense-demo/logger';
import { logsLeakSecrets } from './log-leaks';
import type { AuthRateLimiter } from './rate-limit';
import {
  authTestEnv,
  composeAuthServer,
  memoryTables,
  requestLinkStatus,
} from './auth-server.test-support';
import type { AuthEmailMessage } from './server';

setupRitewayBun();

const email = 'player@offense-demo.example.com';

type Entry = readonly unknown[];
const recordingLogger = (entries: Entry[]): Logger => ({
  log: (...entry) => {
    entries.push(entry);
  },
  child: () => recordingLogger(entries),
});

const compose = (overrides: {
  limiter?: AuthRateLimiter;
  deliveryFailure?: Error;
}) => {
  const sent: AuthEmailMessage[] = [];
  const logged: Entry[] = [];
  const tables = memoryTables();
  const server = composeAuthServer({
    database: memoryAdapter(tables),
    emailSender: {
      send: async (message) => {
        if (overrides.deliveryFailure) throw overrides.deliveryFailure;
        sent.push(message);
      },
    },
    ...(overrides.limiter ? { limiter: overrides.limiter } : {}),
    logger: recordingLogger(logged),
  });
  const requestLink = () => requestLinkStatus(server, email);
  return { server, sent, logged, tables, requestLink };
};

describe('auth server injected seams', () => {
  test('mints entity identifiers from the injected generator', async () => {
    const { requestLink, tables } = compose({});
    await requestLink();
    assert({
      given: 'a sequential id generator and one magic-link request',
      should: 'persist the verification record under the first injected id',
      actual: tables.verification.map(({ id }) => id),
      expected: ['auth-1'],
    });
  });

  test('a denying limiter blocks the magic-link send', async () => {
    const keys: string[] = [];
    const { requestLink, sent, tables, logged } = compose({
      limiter: {
        consume: async (key) => {
          keys.push(key);
          return { allowed: false, retryAfterSeconds: 30 };
        },
      },
    });
    const outcome = await requestLink();
    assert({
      given: 'a limiter that denies the request',
      should:
        'reject with 429 before any durable work, mail, or secret-bearing key or log',
      actual: {
        outcome,
        consulted: keys.length > 0,
        sent: sent.length,
        verifications: tables.verification.length,
        logged: logged.length > 0,
        leaks: logsLeakSecrets([keys, logged], [email]),
      },
      expected: {
        outcome: 'TOO_MANY_REQUESTS',
        consulted: true,
        sent: 0,
        verifications: 0,
        logged: true,
        leaks: false,
      },
    });
  });

  test('a throwing limiter fails closed', async () => {
    const { requestLink, sent, tables, logged } = compose({
      limiter: {
        consume: async () => {
          throw new Error(`redis down while limiting ${email}`);
        },
      },
    });
    const outcome = await requestLink();
    assert({
      given: 'a limiter outage',
      should: 'deny with 503, send nothing, persist nothing, and log safely',
      actual: {
        outcome,
        sent: sent.length,
        verifications: tables.verification.length,
        logged: logged.length > 0,
        leaks: logsLeakSecrets(logged, [email, 'redis down']),
      },
      expected: {
        outcome: 'SERVICE_UNAVAILABLE',
        sent: 0,
        verifications: 0,
        logged: true,
        leaks: false,
      },
    });
  });

  test('a synchronously throwing limiter fails closed', async () => {
    const { requestLink, sent, tables, logged } = compose({
      limiter: {
        consume: () => {
          throw new Error(`invalid limiter key for ${email}`);
        },
      },
    });
    const outcome = await requestLink();
    assert({
      given: 'a limiter that throws before returning a promise',
      should: 'converge on the same safe 503 denial as a rejected promise',
      actual: {
        outcome,
        sent: sent.length,
        verifications: tables.verification.length,
        events: logged.map(([event, fields]) => [event, fields]),
        leaks: logsLeakSecrets(logged, [email, 'invalid limiter key']),
      },
      expected: {
        outcome: 'SERVICE_UNAVAILABLE',
        sent: 0,
        verifications: 0,
        events: [
          [
            'auth.rate_limit.unavailable',
            {
              operation: 'auth.rate_limit',
              path: '/sign-in/magic-link',
              errorCode: 'INFRASTRUCTURE',
            },
          ],
        ],
        leaks: false,
      },
    });
  });

  test('throttles the HTTP handler through the same limiter', async () => {
    const { server, logged } = compose({
      limiter: {
        consume: async () => ({ allowed: false, retryAfterSeconds: 30 }),
      },
    });
    const response = await server.instance.handler(
      new Request(`${authTestEnv.PUBLIC_APP_URL}/api/auth/get-session`),
    );
    assert({
      given: 'a denied non-mail auth request through the HTTP handler',
      should: 'answer 429 with the retry hint and log a named denial event',
      actual: {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        events: logged.map(([event, fields]) => [event, fields]),
      },
      expected: {
        status: 429,
        retryAfter: '30',
        events: [
          [
            'auth.rate_limit.denied',
            {
              operation: 'auth.rate_limit',
              path: '/get-session',
              errorCode: 'RATE_LIMIT',
            },
          ],
        ],
      },
    });
  });

  test('logs mail failure through the injected logger without secrets', async () => {
    const { requestLink, logged, tables } = compose({
      deliveryFailure: new Error('resend provider exception AB12CD'),
    });
    await requestLink();
    const token = String(
      (tables.verification[0] as { identifier?: string } | undefined)
        ?.identifier,
    );
    assert({
      given: 'a failing email sender during a magic-link request',
      should: 'log the failure with no recipient, token or provider detail',
      actual: {
        events: logged.map(([event]) => event),
        leaks: logsLeakSecrets(logged, [email, token, 'AB12CD', 'resend']),
      },
      expected: { events: ['auth.mail.failed'], leaks: false },
    });
  });

  test('logs a delivered mail as a named event without secrets', async () => {
    const { requestLink, logged } = compose({});
    await requestLink();
    assert({
      given: 'a delivered magic-link email',
      should: 'log one delivery event carrying only the operation name',
      actual: {
        events: logged.map(([event, fields]) => [event, fields]),
        leaks: logsLeakSecrets(logged, [email]),
      },
      expected: {
        events: [['auth.mail.sent', { operation: 'auth.mail.send' }]],
        leaks: false,
      },
    });
  });

  test('the leak detector flags a leaking entry', () => {
    assert({
      given: 'log entries where one carries the recipient',
      should: 'report a leak, and report none once it is removed',
      actual: [
        logsLeakSecrets([['event', { to: email }, 'sent']], [email]),
        logsLeakSecrets([['event', { operation: 'send' }, 'sent']], [email]),
      ],
      expected: [true, false],
    });
  });
});
