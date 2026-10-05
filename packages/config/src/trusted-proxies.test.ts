import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { authEnv } from './auth-env.test-support';
import { readAuthConfig, TRUSTED_PROXY_GATEWAY } from './index';

setupRitewayBun();

describe('AUTH_TRUSTED_PROXIES', () => {
  test('accepts the gateway keyword alongside explicit proxy addresses', () => {
    assert({
      given: `AUTH_TRUSTED_PROXIES listing an address and the ${TRUSTED_PROXY_GATEWAY} keyword`,
      should: 'keep both entries for the server edge to resolve',
      actual: readAuthConfig({
        ...authEnv,
        AUTH_TRUSTED_PROXIES: `127.0.0.1, ${TRUSTED_PROXY_GATEWAY}`,
      }).AUTH_TRUSTED_PROXIES,
      expected: ['127.0.0.1', TRUSTED_PROXY_GATEWAY],
    });
  });

  test('refuses an entry that is neither an address nor the keyword', () => {
    expect(() =>
      readAuthConfig({ ...authEnv, AUTH_TRUSTED_PROXIES: 'gateway-ish' }),
    ).toThrow('Invalid auth configuration');
  });
});
