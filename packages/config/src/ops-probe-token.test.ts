import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { authEnv, webhookSecret } from './auth-env.test-support';
import { readAuthConfig } from './index';

setupRitewayBun();

/** The message a rejected configuration throws, or `accepted`. */
const failureOf = (read: () => unknown) => {
  try {
    read();
    return 'accepted';
  } catch (error) {
    return String(error);
  }
};

describe('OPS_PROBE_TOKEN (AUTH-7.7)', () => {
  test('production requires the ops probe token; development does not', () => {
    const production = {
      ...authEnv,
      NODE_ENV: 'production',
      RESEND_WEBHOOK_SECRET: webhookSecret,
    };
    let message = '';
    try {
      readAuthConfig(production);
    } catch (error) {
      message = String(error);
    }
    assert({
      given: 'a production environment without OPS_PROBE_TOKEN',
      should: 'refuse to start naming the field but never a value',
      actual: {
        named: message.includes('OPS_PROBE_TOKEN'),
        leaked: message.includes(authEnv.BETTER_AUTH_SECRET),
      },
      expected: { named: true, leaked: false },
    });
    assert({
      given: 'a production environment with a 32+ character token',
      should: 'validate and expose the token',
      actual: readAuthConfig({
        ...production,
        OPS_PROBE_TOKEN: 'a'.repeat(32),
      }).OPS_PROBE_TOKEN,
      expected: 'a'.repeat(32),
    });
    assert({
      given: 'a development environment without an ops probe token',
      should: 'still validate',
      actual: 'OPS_PROBE_TOKEN' in readAuthConfig(authEnv),
      expected: false,
    });
  });

  test('rejects an ops probe token shorter than 32 characters', () => {
    assert({
      given: 'an ops probe token below the minimum length',
      should: 'reject naming the field',
      actual: failureOf(() =>
        readAuthConfig({ ...authEnv, OPS_PROBE_TOKEN: 'too-short' }),
      ),
      expected: 'Error: Invalid auth configuration: OPS_PROBE_TOKEN',
    });
  });
});
