import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { fixedClock, sequentialId } from '@offense-demo/clock';
import { rejectionOf } from '@offense-demo/errors/testing';
import { authTestEnv } from '../features/auth/auth-server.test-support';
import { createApp } from './app';

setupRitewayBun();

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unit:unit@localhost:5432/unit',
  REDIS_URL: 'redis://localhost:6379',
  REDIS_NAMESPACE: 'unit-a',
  PUBLIC_APP_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
};

type Sent = { readonly url: string; readonly to: string };

/** A fetch that records Resend calls and answers them, touching no network. */
function recordingFetch() {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { to: string[] };
    sent.push({ url: String(input), to: body.to[0] ?? '' });
    return Response.json({ id: `msg_${sent.length}` });
  };
  return { sent, fetch };
}

const build = (env: Record<string, string>, fetch = recordingFetch().fetch) =>
  createApp({
    env,
    fetch,
    clock: fixedClock('2026-09-23T00:00:00.000Z'),
    ids: sequentialId('app'),
  });

const errorOf = (run: () => unknown) => {
  try {
    run();
    return '';
  } catch (error) {
    return String(error);
  }
};

describe('createApp', () => {
  test('builds independent instances from their own environments', async () => {
    const first = build(baseEnv);
    const second = build({
      ...baseEnv,
      REDIS_NAMESPACE: 'unit-b',
      PUBLIC_APP_URL: 'https://second.example',
    });
    first.drain();
    const observed = {
      first: [first.config.REDIS_NAMESPACE, first.isDraining()],
      second: [second.config.REDIS_NAMESPACE, second.isDraining()],
    };
    await Promise.all([first.close(), second.close()]);
    assert({
      given: 'two apps built in one process from different environments',
      should: 'keep each validated config and drain state to its own instance',
      actual: observed,
      expected: {
        first: ['unit-a', true],
        second: ['unit-b', false],
      },
    });
  });

  test('refuses an invalid environment naming fields, never values', () => {
    const message = errorOf(() =>
      build({
        ...baseEnv,
        DATABASE_URL: 'mysql://unit:SECRET@localhost:3306/unit',
      }),
    );
    assert({
      given: 'an environment whose database URL fails validation',
      should: 'throw naming the field without echoing its value',
      actual: {
        names: message.includes('DATABASE_URL'),
        leaks: message.includes('SECRET'),
      },
      expected: { names: true, leaks: false },
    });
  });

  test('validates auth configuration only when auth is first used', async () => {
    const app = build({
      ...baseEnv,
      ...authTestEnv,
      BETTER_AUTH_SECRET: 'too-short',
    });
    const message = errorOf(() => app.auth());
    await app.close();
    assert({
      given: 'a baseline-valid environment with an invalid auth secret',
      should:
        'build the app, then refuse auth naming the field without its value',
      actual: {
        names: message.includes('BETTER_AUTH_SECRET'),
        leaks: message.includes('too-short'),
      },
      expected: { names: true, leaks: false },
    });
  });

  test('composes auth once per instance', async () => {
    const app = build({ ...baseEnv, ...authTestEnv });
    const same = app.auth() === app.auth();
    await app.close();
    assert({
      given: 'two reads of one app instance auth',
      should: 'return the same composed server',
      actual: same,
      expected: true,
    });
  });

  test('refuses the delivery webhook without a signing secret', async () => {
    const app = build({ ...baseEnv, ...authTestEnv });
    const refusal = await rejectionOf(() => app.mailWebhook());
    await app.close();
    assert({
      given: 'auth configuration without RESEND_WEBHOOK_SECRET',
      should: 'refuse to compose the webhook as an infrastructure error',
      actual: refusal,
      expected: { code: 'INFRASTRUCTURE' },
    });
  });
  test('selects the terminal mailer only for local development without Resend', async () => {
    const withoutResend = (env: Record<string, string>) => {
      const copy: Record<string, string> = { ...env };
      Reflect.deleteProperty(copy, 'RESEND_API_KEY');
      Reflect.deleteProperty(copy, 'AUTH_EMAIL_FROM');
      return copy;
    };
    const development = build(
      withoutResend({ ...baseEnv, ...authTestEnv, NODE_ENV: 'development' }),
    );
    const transport = development.auth().config.mailTransport;
    const webhook = await rejectionOf(() => development.mailWebhook());
    await development.close();
    const testBuild = build(withoutResend({ ...baseEnv, ...authTestEnv }));
    const testRefusal = errorOf(() => testBuild.auth());
    await testBuild.close();
    const production = build(
      withoutResend({
        ...baseEnv,
        ...authTestEnv,
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'https://offense-demo.example.com',
        DATABASE_URL: 'postgres://unit:unit@db.internal:5432/unit',
        APP_VERSION: '1.0.0',
        GIT_COMMIT: 'abc1234',
        RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('placeholder-webhook-key').toString('base64')}`,
        OPS_PROBE_TOKEN: 'p'.repeat(32),
      }),
    );
    const productionRefusal = errorOf(() => production.auth());
    await production.close();
    assert({
      given:
        'the same auth environment without Resend at development, test and production',
      should:
        'compose the terminal mailer in development only; test and production refuse naming the Resend fields',
      actual: {
        transport,
        webhook,
        testRefuses: testRefusal.includes('RESEND_API_KEY'),
        productionRefuses: productionRefusal.includes(
          'Invalid auth configuration: RESEND_API_KEY, AUTH_EMAIL_FROM',
        ),
      },
      expected: {
        transport: 'terminal',
        webhook: { code: 'INFRASTRUCTURE' },
        testRefuses: true,
        productionRefuses: true,
      },
    });
  });
});
