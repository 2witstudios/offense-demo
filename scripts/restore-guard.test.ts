import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  refusalFor,
  refusalForActualName,
  refusalForRedis,
  refusalForStagingSeed,
} from './restore-guard';

setupRitewayBun();

describe('restore-guard: refusalFor', () => {
  test('allows a database name naming itself a restore copy', () => {
    assert({
      given: 'a DATABASE_URL whose database name contains "restore"',
      should: 'not refuse',
      actual: refusalFor(
        'postgres://u:p@host:5432/offense_demo_restore_rehearsal',
        false,
      ),
      expected: undefined,
    });
  });

  test('is case-insensitive about the "restore" marker', () => {
    assert({
      given: 'a database name with "Restore" capitalized',
      should: 'not refuse',
      actual: refusalFor('postgres://u:p@host:5432/OffenseDemo_Restore', false),
      expected: undefined,
    });
  });

  test('refuses a database name with no restore marker', () => {
    assert({
      given: 'the live staging database name',
      should: 'refuse with a message naming the database',
      actual: refusalFor(
        'postgres://u:p@host:5432/offense_demo_staging',
        false,
      )?.includes('offense_demo_staging'),
      expected: true,
    });
  });

  test('--force overrides the name check', () => {
    assert({
      given: 'force true and a database name with no restore marker',
      should: 'not refuse',
      actual: refusalFor('postgres://u:p@host:5432/anything', true),
      expected: undefined,
    });
  });
});

describe('restore-guard: refusalFor cannot see a ?database= override', () => {
  test('a URL whose path names a restore copy but whose ?database= query overrides it passes the URL check', () => {
    // Bun's SQL client honors a ?database= query parameter over the URL's
    // own path (standard libpq connection-string behavior): this URL's
    // path looks safe, but the connection it opens lands on
    // offense_demo_staging. refusalFor only ever sees the path, so it is
    // fooled — refusalForActualName (checked against current_database()
    // after connecting) is what actually catches this, in the next
    // describe block.
    assert({
      given:
        'a restore-named path with a ?database= query overriding it to the live database',
      should: 'not refuse, because refusalFor only parses the URL path',
      actual: refusalFor(
        'postgres://u:p@host:5432/offense_demo_restore_rehearsal?database=offense_demo_staging',
        false,
      ),
      expected: undefined,
    });
  });
});

describe('restore-guard: refusalForActualName', () => {
  test('catches exactly the ?database= bypass the URL-only check above misses', () => {
    // The same scenario as above, but checked against the name the server
    // actually reports (current_database()) instead of the URL string.
    assert({
      given:
        'current_database() reporting the live database despite a restore-named URL path',
      should: 'refuse, naming the actual database in the message',
      actual: refusalForActualName(
        'offense_demo_staging',
        'restore',
        false,
      )?.includes('offense_demo_staging'),
      expected: true,
    });
    assert({
      given: 'the actual database name naming itself correctly',
      should: 'not refuse',
      actual: refusalForActualName(
        'offense_demo_restore_rehearsal',
        'restore',
        false,
      ),
      expected: undefined,
    });
  });

  test('--force overrides the actual-name check too', () => {
    assert({
      given: 'force true and an actual name with no marker',
      should: 'not refuse',
      actual: refusalForActualName('anything', 'restore', true),
      expected: undefined,
    });
  });
});

describe('restore-guard: refusalForStagingSeed', () => {
  test('allows a database name naming itself staging', () => {
    assert({
      given: 'a DATABASE_URL whose database name contains "staging"',
      should: 'not refuse',
      actual: refusalForStagingSeed(
        'postgres://u:p@host:5432/offense_demo_staging',
        false,
      ),
      expected: undefined,
    });
  });

  test('refuses a database name with no staging marker', () => {
    assert({
      given: 'a production-shaped database name',
      should: 'refuse with a message naming the database',
      actual: refusalForStagingSeed(
        'postgres://u:p@host:5432/offense_demo_production',
        false,
      )?.includes('offense_demo_production'),
      expected: true,
    });
  });

  test('--force overrides the name check', () => {
    assert({
      given: 'force true and a database name with no staging marker',
      should: 'not refuse',
      actual: refusalForStagingSeed('postgres://u:p@host:5432/anything', true),
      expected: undefined,
    });
  });
});

describe('restore-guard: refusalForRedis', () => {
  const url = 'redis://:secret-password@redis.internal:6379';

  test('allows a namespace with no naming convention when both are explicitly confirmed', () => {
    assert({
      given:
        '--confirm-redis-namespace and --confirm-redis-host matching exactly, even "offense-demo"',
      should: 'not refuse',
      actual: refusalForRedis(
        url,
        'offense-demo',
        'offense-demo',
        'redis.internal:6379',
      ),
      expected: undefined,
    });
  });

  test('refuses when no confirmation was passed', () => {
    assert({
      given: 'no --confirm-redis-namespace or --confirm-redis-host at all',
      should: 'refuse with a message naming the namespace and the host',
      actual: [
        refusalForRedis(
          url,
          'offense-demo-restore-rehearsal',
          undefined,
          undefined,
        )?.includes('offense-demo-restore-rehearsal'),
        refusalForRedis(
          url,
          'offense-demo-restore-rehearsal',
          undefined,
          undefined,
        )?.includes('redis.internal:6379'),
      ],
      expected: [true, true],
    });
  });

  test('never includes the password from REDIS_URL in its refusal message', () => {
    assert({
      given: 'a REDIS_URL carrying a password',
      should: 'never echo the password back',
      actual: refusalForRedis(
        url,
        'offense-demo',
        undefined,
        undefined,
      )?.includes('secret-password'),
      expected: false,
    });
  });

  test('refuses when the namespace confirmation does not match', () => {
    assert({
      given: 'a namespace confirmation for a different namespace, host correct',
      should: 'refuse',
      actual:
        refusalForRedis(
          url,
          'offense-demo-restore-rehearsal',
          'offense-demo',
          'redis.internal:6379',
        ) === undefined,
      expected: false,
    });
  });

  test('refuses when the host confirmation does not match', () => {
    assert({
      given: 'a host confirmation for a different host, namespace correct',
      should: 'refuse',
      actual:
        refusalForRedis(
          url,
          'offense-demo',
          'offense-demo',
          'some-other-host:6379',
        ) === undefined,
      expected: false,
    });
  });
});
