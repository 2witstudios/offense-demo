import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { APIError } from 'better-auth/api';
import type { Logger } from '@offense-demo/logger';
import { createEventRecorder as recorder } from '../../server/test-loggers.test-support';
import {
  appendSessionRevokedBestEffort,
  sessionRevokedOutboxPlugin,
} from './session-revoked-outbox';

setupRitewayBun();

const context = (path: string, returned: unknown, userId?: string) => ({
  path,
  context: {
    returned,
    session: userId ? { user: { id: userId } } : undefined,
  },
});

const runAfterHook = async (
  appendSessionRevoked: (userId: string) => Promise<void>,
  logger: Logger,
  path: string,
  returned: unknown,
  userId?: string,
) => {
  const plugin = sessionRevokedOutboxPlugin(appendSessionRevoked, logger);
  const hook = plugin.hooks?.after?.[0];
  if (!hook) throw new Error('plugin defines no after hook');
  const ctx = context(path, returned, userId);
  if (!hook.matcher(ctx as never)) return 'not-matched';
  await hook.handler(ctx as never);
  return 'ran';
};

/** The user ids the hook appended for one response. */
const appendedAfter = async (
  path: string,
  returned: unknown,
  userId?: string,
) => {
  const appended: string[] = [];
  await runAfterHook(
    async (id) => void appended.push(id),
    recorder().logger,
    path,
    returned,
    userId,
  );
  return appended;
};

describe('sessionRevokedOutboxPlugin matcher', () => {
  test('matches only the single-session revoke, whose delete Better Auth owns', () => {
    const { logger } = recorder();
    const plugin = sessionRevokedOutboxPlugin(async () => {}, logger);
    const hook = plugin.hooks?.after?.[0];
    if (!hook) throw new Error('plugin defines no after hook');
    const paths = [
      '/revoke-session',
      '/revoke-other-sessions',
      '/revoke-sessions',
      '/sign-in/magic-link',
      '/list-sessions',
    ];
    assert({
      given:
        'the three self-service revoke paths and two unrelated paths, the two revoke-alls being Offense Demo-owned (ISSUE-22)',
      should:
        'match only /revoke-session: the revoke-alls append in their own transaction',
      actual: paths.map((path) => hook.matcher(context(path, {}) as never)),
      expected: [true, false, false, false, false],
    });
  });
});

describe('sessionRevokedOutboxPlugin handler', () => {
  test('appends once for a successful response with a userId', async () => {
    const appended = await appendedAfter(
      '/revoke-session',
      { status: true },
      'user-1',
    );
    assert({
      given: 'a {status:true} response and a session userId',
      should: 'append exactly one doorbell for that user',
      actual: appended,
      expected: ['user-1'],
    });
  });

  test('does not append for an APIError response, even with a userId', async () => {
    const appended = await appendedAfter(
      '/revoke-session',
      new APIError('UNAUTHORIZED'),
      'user-1',
    );
    assert({
      given: 'an APIError response',
      should: 'append nothing',
      actual: appended,
      expected: [],
    });
  });

  test('does not append when the response is missing status:true', async () => {
    const appended = await appendedAfter(
      '/revoke-session',
      { status: false },
      'user-1',
    );
    assert({
      given: 'a response that is not {status:true}',
      should: 'append nothing',
      actual: appended,
      expected: [],
    });
  });

  test('does not append when no session userId is available', async () => {
    const appended = await appendedAfter(
      '/revoke-session',
      { status: true },
      undefined,
    );
    assert({
      given: 'a successful response with no session on the context',
      should: 'append nothing',
      actual: appended,
      expected: [],
    });
  });

  test('a failing append is swallowed and logged as a registered event, never thrown out of the hook', async () => {
    const { logged, logger } = recorder();
    let outcome: 'threw' | 'resolved' = 'resolved';
    try {
      await runAfterHook(
        async () => {
          throw new Error('outbox unavailable: password=hunter2');
        },
        logger,
        '/revoke-session',
        { status: true },
        'user-1',
      );
    } catch {
      outcome = 'threw';
    }
    assert({
      given: 'an appendSessionRevoked that rejects with a sensitive message',
      should:
        'resolve the hook anyway and log the registered failure event with no error detail',
      actual: {
        outcome,
        logged: logged.map(({ event, fields }) => [event, fields]),
        leaked: JSON.stringify(logged).includes('hunter2'),
      },
      expected: {
        outcome: 'resolved',
        logged: [
          [
            'realtime.outbox.append_failed',
            {
              operation: 'auth.session_revoked_outbox',
              errorCode: 'INFRASTRUCTURE',
            },
          ],
        ],
        leaked: false,
      },
    });
  });
});

describe('appendSessionRevokedBestEffort', () => {
  test('logs nothing when the append succeeds', async () => {
    const { logged, logger } = recorder();
    await appendSessionRevokedBestEffort(
      async () => {},
      logger,
      'some.operation',
      'user-1',
    );
    assert({
      given: 'an append that succeeds',
      should: 'log nothing',
      actual: logged,
      expected: [],
    });
  });
});
