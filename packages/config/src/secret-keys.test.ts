import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { secretConfigKeys } from './index';

setupRitewayBun();

describe('secret configuration keys', () => {
  test('lists every schema field marked secret, across every schema', () => {
    assert({
      given: 'the server, realtime, auth and migration schemas',
      should:
        'derive the secret-bearing keys from the fields themselves, each once',
      actual: [...secretConfigKeys].sort(),
      expected: [
        'BETTER_AUTH_SECRET',
        'DATABASE_URL',
        'MIGRATION_DATABASE_URL',
        'OPS_PROBE_TOKEN',
        'RECIPIENT_HASH_SECRET',
        'REDIS_URL',
        'RESEND_API_KEY',
        'RESEND_WEBHOOK_SECRET',
      ],
    });
  });
});
