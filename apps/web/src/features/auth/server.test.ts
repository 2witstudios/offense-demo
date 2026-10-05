import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { memoryAdapter } from '@better-auth/memory-adapter';
import type { BetterAuthOptions } from 'better-auth';
import {
  authTestEnv,
  capturingSender,
  composeAuthServer,
  memoryTables,
} from './auth-server.test-support';
import type { AuthEmailMessage } from './server';

setupRitewayBun();

const message: AuthEmailMessage = {
  to: 'player@offense-demo.example.com',
  subject: 'Sign in to Offense Demo',
  text: 'Open the link to continue.',
  html: '<p>Open the link to continue.</p>',
};

const requestLink = (server: ReturnType<typeof composeAuthServer>) =>
  server.instance.api.signInMagicLink({
    body: { email: message.to },
    headers: new Headers({ origin: authTestEnv.PUBLIC_APP_URL }),
  });

describe('auth server composition', () => {
  test('exposes the validated configuration it was given', () => {
    assert({
      given: 'configuration validated from the required auth variables',
      should: 'expose it with an empty proxy list',
      actual: composeAuthServer().config,
      expected: {
        BETTER_AUTH_SECRET: authTestEnv.BETTER_AUTH_SECRET,
        RECIPIENT_HASH_SECRET: authTestEnv.RECIPIENT_HASH_SECRET,
        PUBLIC_APP_URL: authTestEnv.PUBLIC_APP_URL,
        mailTransport: 'resend',
        RESEND_API_KEY: authTestEnv.RESEND_API_KEY,
        AUTH_EMAIL_FROM: authTestEnv.AUTH_EMAIL_FROM,
        AUTH_TRUSTED_PROXIES: [],
      },
    });
  });

  test('composes lazily without querying the injected database adapter', async () => {
    let adapterQueries = 0;
    const underlying = memoryAdapter(memoryTables());
    const database: BetterAuthOptions['database'] = (options) => {
      const adapter = underlying(options);
      return new Proxy(adapter, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args: readonly unknown[]) => {
            adapterQueries += 1;
            return value.apply(target, args);
          };
        },
      });
    };
    const server = composeAuthServer({ database });
    const composed = {
      configValidated:
        server.config.BETTER_AUTH_SECRET === authTestEnv.BETTER_AUTH_SECRET,
      adapterQueries,
    };
    await server.instance.api.signInMagicLink({
      body: { email: 'player@offense-demo.example.com' },
      headers: new Headers({ origin: 'http://localhost:3000' }),
    });
    assert({
      given: 'a query-counting database adapter',
      should:
        'compose the validated configuration with zero queries and reach the adapter only through operations',
      actual: {
        composed,
        reachedAdapterOnlyThroughOperations: adapterQueries > 0,
      },
      expected: {
        composed: { configValidated: true, adapterQueries: 0 },
        reachedAdapterOnlyThroughOperations: true,
      },
    });
  });

  test('returns only the members production reads', () => {
    assert({
      given: 'a composed auth server',
      should:
        'expose config, instance, limiter, logger, clock, settled and pendingWork, and no test-only mail seam',
      actual: Object.keys(composeAuthServer()).sort(),
      expected: [
        'clock',
        'config',
        'instance',
        'limiter',
        'logger',
        'pendingWork',
        'settled',
      ],
    });
  });

  test('delivers mail through the injected sender exactly once', async () => {
    const sender = capturingSender();
    const server = composeAuthServer({ emailSender: sender });
    await requestLink(server);
    assert({
      given: 'a magic-link request and a capturing email sender',
      should: 'hand exactly one message for that recipient to the sender',
      actual: sender.sent.map((sent) => sent.to),
      expected: [message.to],
    });
  });

  test('maps sender failure to a retryable error without provider detail', async () => {
    const server = composeAuthServer({
      emailSender: {
        send: async () => {
          throw new Error('resend provider exception AB12CD');
        },
      },
    });
    const response = await server.instance.handler(
      new Request('http://localhost:3000/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email: message.to }),
      }),
    );
    const text = await response.text();
    assert({
      given: 'a magic-link request whose email sender fails',
      should:
        'answer the generic retryable delivery failure that never leaks the cause',
      actual: {
        status: response.status,
        code: (JSON.parse(text) as { code?: string }).code,
        safeMessage: !text.includes('resend') && !text.includes('AB12CD'),
      },
      expected: {
        status: 503,
        code: 'EMAIL_DELIVERY_FAILED',
        safeMessage: true,
      },
    });
  });
});
