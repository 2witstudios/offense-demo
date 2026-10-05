import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { readAuthConfig } from '@offense-demo/config';
import {
  authTestEnv,
  capturingSender,
  composeAuthServer,
} from './auth-server.test-support';

setupRitewayBun();

describe('auth instance composition', () => {
  test('composes the Better Auth instance from the validated configuration', async () => {
    const server = composeAuthServer();
    const { options } = await server.instance.$context;
    assert({
      given: 'the validated auth configuration',
      should:
        'wire baseURL, the trusted application origin and the secret with passwords disabled',
      actual: {
        baseURL: options.baseURL,
        trustedOrigins: options.trustedOrigins,
        passwordEnabled: options.emailAndPassword?.enabled,
        idGenerator: typeof options.advanced?.database?.generateId,
      },
      expected: {
        baseURL: 'http://localhost:3000',
        trustedOrigins: ['http://localhost:3000'],
        passwordEnabled: false,
        idGenerator: 'function',
      },
    });
  });

  test('configures magic-link and passkey with a relying party derived from the application URL', async () => {
    const server = composeAuthServer({
      config: readAuthConfig({
        ...authTestEnv,
        PUBLIC_APP_URL: 'https://offense-demo.example.com',
      }),
    });
    const { options } = await server.instance.$context;
    const byId = new Map(
      (options.plugins ?? []).map((plugin) => [
        plugin.id,
        plugin.options as Record<string, unknown>,
      ]),
    );
    assert({
      given: 'a validated application URL',
      should:
        'enable magic-link and passkey with the RP identity derived from the origin',
      actual: {
        magicLinkSender: typeof byId.get('magic-link')?.sendMagicLink,
        rpID: byId.get('passkey')?.rpID,
        rpName: byId.get('passkey')?.rpName,
        origin: byId.get('passkey')?.origin,
      },
      expected: {
        magicLinkSender: 'function',
        rpID: 'offense-demo.example.com',
        rpName: 'Offense Demo',
        origin: 'https://offense-demo.example.com',
      },
    });
  });

  test('asks for discoverable passkeys from any authenticator', async () => {
    const server = composeAuthServer();
    const { options } = await server.instance.$context;
    const passkeyOptions = (options.plugins ?? []).find(
      (plugin) => plugin.id === 'passkey',
    )?.options as Record<string, unknown> | undefined;
    assert({
      given: 'the passkey plugin configuration',
      should:
        'require a discoverable credential without restricting it to the platform, so roaming keys still enroll',
      actual: passkeyOptions?.['authenticatorSelection'],
      expected: { residentKey: 'required', userVerification: 'preferred' },
    });
  });

  test('hints the device authenticator first on passkey sign-in options', async () => {
    const server = composeAuthServer();
    const response = await server.instance.handler(
      new Request(
        'http://localhost:3000/api/auth/passkey/generate-authenticate-options',
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert({
      given: 'a request for passkey sign-in options',
      should:
        'carry an advisory client-device hint alongside a fresh challenge and exactly one challenge cookie',
      actual: {
        status: response.status,
        hints: body['hints'],
        challenge: typeof body['challenge'],
        challengeCookies: response.headers.getSetCookie().length,
      },
      expected: {
        status: 200,
        hints: ['client-device'],
        challenge: 'string',
        challengeCookies: 1,
      },
    });
  });

  test('leaves a refused passkey options request untouched', async () => {
    const server = composeAuthServer();
    const response = await server.instance.handler(
      new Request(
        'http://localhost:3000/api/auth/passkey/generate-register-options',
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;
    assert({
      given: 'registration options requested without a session',
      should: 'keep the refusal and add no hint to the error body',
      actual: { status: response.status, hints: body['hints'] },
      expected: { status: 401, hints: undefined },
    });
  });

  test('delivers requested magic links through the injected sender', async () => {
    const sender = capturingSender();
    const server = composeAuthServer({ emailSender: sender });
    await server.instance.api.signInMagicLink({
      body: { email: 'player@offense-demo.example.com' },
      headers: new Headers({ origin: 'http://localhost:3000' }),
    });
    assert({
      given: 'a magic-link sign-in request',
      should: 'deliver exactly one message through the injected sender',
      actual: sender.sent.map(({ to, subject }) => ({ to, subject })),
      expected: [
        {
          to: 'player@offense-demo.example.com',
          subject: 'Sign in to Offense Demo',
        },
      ],
    });
  });

  test('refuses direct calls to the disabled account-deletion endpoints', async () => {
    const server = composeAuthServer();
    const paths = ['/api/auth/delete-user', '/api/auth/delete-user/callback'];
    const statuses = [];
    const setCookies = [];
    for (const path of paths) {
      const response = await server.instance.handler(
        new Request(`http://localhost:3000${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      statuses.push(response.status);
      setCookies.push(response.headers.has('set-cookie'));
    }
    assert({
      given: 'direct calls to /delete-user and /delete-user/callback',
      should: 'refuse both without any account-deletion effect',
      actual: { statuses, setCookies },
      expected: {
        statuses: [404, 404],
        setCookies: [false, false],
      },
    });
  });

  test('refuses direct calls to password signup, signin and reset endpoints', async () => {
    const server = composeAuthServer();
    const passwords = ['Sup3rSecret!', 'Sup3rSecret!', 'Sup3rSecret!'];
    const paths = [
      '/api/auth/sign-up/email',
      '/api/auth/sign-in/email',
      '/api/auth/forget-password',
    ];
    const statuses = [];
    const setCookies = [];
    for (const [index, path] of paths.entries()) {
      const response = await server.instance.handler(
        new Request(`http://localhost:3000${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: 'player@offense-demo.example.com',
            password: passwords[index],
          }),
        }),
      );
      statuses.push(response.status);
      setCookies.push(response.headers.has('set-cookie'));
    }
    assert({
      given: 'direct calls to password signup, signin and reset endpoints',
      should: 'refuse every password route without issuing a session',
      actual: { statuses, setCookies },
      expected: {
        statuses: [404, 404, 404],
        setCookies: [false, false, false],
      },
    });
  });
});
