import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { APIError } from 'better-auth/api';
import type { Logger } from '@offense-demo/logger';
import { createEventRecorder as recorder } from '../../server/test-loggers.test-support';
import { passkeyNotificationsPlugin } from './passkey-notifications';
import type { Deliver } from './deliver-or-unavailable';
import type { AuthEmailMessage } from './server';

setupRitewayBun();

const origin = 'https://offense-demo.example.com';
const email = 'player@offense-demo.example.com';

const context = (
  path: string,
  session: { user: { email: string } } | undefined,
  returned: unknown = { status: true },
) => ({ path, context: { session, returned } });

const runAfterHook = async (
  deliver: Deliver,
  logger: Logger,
  path: string,
  session: Parameters<typeof context>[1],
  returned?: unknown,
) => {
  const plugin = passkeyNotificationsPlugin(origin, deliver, logger);
  const hook = plugin.hooks?.after?.[0];
  if (!hook) throw new Error('plugin defines no after hook');
  const ctx = context(path, session, returned);
  if (!hook.matcher(ctx as never)) return 'not-matched';
  await hook.handler(ctx as never);
  return 'matched';
};

/** The notices the hook delivered for one response. */
const sentAfter = async (
  path: string,
  session: Parameters<typeof context>[1],
  returned?: unknown,
) => {
  const sent: AuthEmailMessage[] = [];
  await runAfterHook(
    async (message) => {
      sent.push(message);
      return 'sent';
    },
    recorder().logger,
    path,
    session,
    returned,
  );
  return sent;
};

describe('passkeyNotificationsPlugin matcher', () => {
  test('matches only the registration and deletion paths', () => {
    const { logger } = recorder();
    const plugin = passkeyNotificationsPlugin(
      origin,
      async () => 'sent',
      logger,
    );
    const hook = plugin.hooks?.after?.[0];
    if (!hook) throw new Error('plugin defines no after hook');
    const paths = [
      '/passkey/verify-registration',
      '/passkey/delete-passkey',
      '/passkey/generate-register-options',
      '/verify-email',
    ];
    assert({
      given: 'the two notified paths and two unrelated ones',
      should: 'match only the registration and deletion paths',
      actual: paths.map((path) =>
        hook.matcher(context(path, { user: { email } }) as never),
      ),
      expected: [true, true, false, false],
    });
  });
});

describe('passkeyNotificationsPlugin handler', () => {
  test('sends the passkey-added notice on a successful registration', async () => {
    const sent = await sentAfter('/passkey/verify-registration', {
      user: { email },
    });
    assert({
      given: 'a successful passkey registration for a signed-in session',
      should: 'deliver exactly one passkey-added notice to that address',
      actual: {
        count: sent.length,
        to: sent[0]?.to,
        subjectMentionsAdded: sent[0]?.subject.toLowerCase().includes('added'),
      },
      expected: { count: 1, to: email, subjectMentionsAdded: true },
    });
  });

  test('sends the passkey-removed notice on a successful deletion', async () => {
    const sent = await sentAfter('/passkey/delete-passkey', {
      user: { email },
    });
    assert({
      given: 'a successful passkey deletion for a signed-in session',
      should: 'deliver exactly one passkey-removed notice to that address',
      actual: {
        count: sent.length,
        to: sent[0]?.to,
        subjectMentionsRemoved: sent[0]?.subject
          .toLowerCase()
          .includes('removed'),
      },
      expected: { count: 1, to: email, subjectMentionsRemoved: true },
    });
  });

  test('sends nothing when the endpoint itself failed', async () => {
    const sent = await sentAfter(
      '/passkey/delete-passkey',
      { user: { email } },
      new APIError('FORBIDDEN', { message: 'not yours' }),
    );
    assert({
      given: 'a failed passkey deletion (the endpoint returned an APIError)',
      should: 'send no notification',
      actual: sent.length,
      expected: 0,
    });
  });

  test('sends nothing without a session on the context', async () => {
    const sent = await sentAfter('/passkey/verify-registration', undefined);
    assert({
      given: 'no session on the after-hook context',
      should: 'send no notification',
      actual: sent.length,
      expected: 0,
    });
  });

  test('a delivery failure is swallowed and logged, never thrown', async () => {
    const { logged, logger } = recorder();
    let threw = false;
    try {
      await runAfterHook(
        async () => {
          throw new Error('resend down: api_key=hunter2');
        },
        logger,
        '/passkey/verify-registration',
        { user: { email } },
      );
    } catch {
      threw = true;
    }
    assert({
      given: 'a delivery function that rejects with a sensitive message',
      should:
        'resolve the hook anyway and log the registered event with no error detail',
      actual: {
        threw,
        logged: logged.map(({ event, fields }) => [event, fields]),
        leaked: JSON.stringify(logged).includes('hunter2'),
      },
      expected: {
        threw: false,
        logged: [
          [
            'auth.passkey.notification_failed',
            { operation: 'auth.passkey_notify' },
          ],
        ],
        leaked: false,
      },
    });
  });
});
