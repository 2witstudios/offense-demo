import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { authEnv, failureOf, webhookSecret } from './auth-env.test-support';
import { readAuthConfig } from './index';

setupRitewayBun();

/** `authEnv` without any Resend credential, at the given environment and origin. */
const withoutResend = (
  NODE_ENV: string,
  PUBLIC_APP_URL = 'http://localhost:3000',
  extra: Record<string, string> = {},
) => {
  const env: Record<string, string | undefined> = {
    ...authEnv,
    NODE_ENV,
    PUBLIC_APP_URL,
  };
  Reflect.deleteProperty(env, 'RESEND_API_KEY');
  Reflect.deleteProperty(env, 'AUTH_EMAIL_FROM');
  return { ...env, ...extra };
};

const productionExtras = {
  RESEND_WEBHOOK_SECRET: webhookSecret,
  OPS_PROBE_TOKEN: 'a'.repeat(32),
};

const missingResend =
  'Error: Invalid auth configuration: RESEND_API_KEY, AUTH_EMAIL_FROM';

describe('terminal mailer selection (ADR 0050)', () => {
  test('local development without Resend selects the terminal mailer', () => {
    const transports = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ].map(
      (url) => readAuthConfig(withoutResend('development', url)).mailTransport,
    );
    assert({
      given:
        'NODE_ENV=development, a loopback PUBLIC_APP_URL and no Resend variables',
      should: 'validate and select the terminal mailer for every loopback host',
      actual: transports,
      expected: ['terminal', 'terminal', 'terminal'],
    });
  });

  test('the terminal configuration carries no Resend fields', () => {
    const config = readAuthConfig(withoutResend('development'));
    assert({
      given: 'a terminal-mailer configuration',
      should: 'expose neither RESEND_API_KEY nor AUTH_EMAIL_FROM',
      actual: ['RESEND_API_KEY', 'AUTH_EMAIL_FROM'].filter(
        (field) => field in config,
      ),
      expected: [],
    });
  });

  test('a configured Resend key always wins in development', () => {
    assert({
      given: 'NODE_ENV=development on localhost with Resend configured',
      should: 'select Resend, never the terminal mailer',
      actual: readAuthConfig({
        ...authEnv,
        PUBLIC_APP_URL: 'http://localhost:3000',
      }).mailTransport,
      expected: 'resend',
    });
  });

  test('production without Resend refuses rather than fall back', () => {
    assert({
      given:
        'NODE_ENV=production with every other production field but no Resend variables',
      should: 'refuse naming both Resend fields, never select the terminal',
      actual: failureOf(() =>
        readAuthConfig(
          withoutResend(
            'production',
            'https://offense-demo.example.com',
            productionExtras,
          ),
        ),
      ),
      expected: missingResend,
    });
  });

  test('production on a loopback origin still refuses without Resend', () => {
    assert({
      given: 'NODE_ENV=production on https://localhost with no Resend key',
      should: 'refuse: the loopback exception is development-only',
      actual: failureOf(() =>
        readAuthConfig(
          withoutResend('production', 'https://localhost', productionExtras),
        ),
      ),
      expected: missingResend,
    });
  });

  test('test builds refuse without Resend', () => {
    assert({
      given: 'NODE_ENV=test on localhost with no Resend variables',
      should: 'refuse naming both Resend fields',
      actual: failureOf(() => readAuthConfig(withoutResend('test'))),
      expected: missingResend,
    });
  });

  test('a development server on a non-loopback origin refuses without Resend', () => {
    assert({
      given:
        'NODE_ENV=development on a hosted origin (a misconfigured deployed dev server)',
      should: 'refuse rather than print magic links into hosted logs',
      actual: failureOf(() =>
        readAuthConfig(
          withoutResend('development', 'https://dev.offense-demo.example.com'),
        ),
      ),
      expected: missingResend,
    });
  });

  test('a loopback-looking subdomain is not loopback', () => {
    assert({
      given: 'a development origin of localhost.offense-demo.example.com',
      should: 'refuse without Resend',
      actual: failureOf(() =>
        readAuthConfig(
          withoutResend(
            'development',
            'http://localhost.offense-demo.example.com',
          ),
        ),
      ),
      expected: missingResend,
    });
  });

  test('a half-configured Resend refuses even in local development', () => {
    assert({
      given:
        'NODE_ENV=development on localhost with RESEND_API_KEY but no AUTH_EMAIL_FROM',
      should: 'refuse naming the missing field rather than pick a transport',
      actual: failureOf(() =>
        readAuthConfig(
          withoutResend('development', 'http://localhost:3000', {
            RESEND_API_KEY: authEnv.RESEND_API_KEY,
          }),
        ),
      ),
      expected: 'Error: Invalid auth configuration: AUTH_EMAIL_FROM',
    });
  });

  test('no environment variable can force the terminal mailer', () => {
    assert({
      given: 'a production environment that also sets mailTransport=terminal',
      should: 'ignore it and select Resend',
      actual: readAuthConfig({
        ...authEnv,
        ...productionExtras,
        NODE_ENV: 'production',
        mailTransport: 'terminal',
      }).mailTransport,
      expected: 'resend',
    });
  });
});
