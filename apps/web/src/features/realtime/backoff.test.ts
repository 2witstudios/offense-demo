import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { nextReconnectDelayMs } from './backoff';

setupRitewayBun();

describe('nextReconnectDelayMs (ADR 0031 §8: jittered backoff, no lifetime ceiling)', () => {
  test('a standard reconnect grows exponentially, capped, with full jitter', () => {
    const delays = [0, 1, 2, 10].map((attempt) =>
      nextReconnectDelayMs({ kind: 'standard', attempt, random: () => 1 }),
    );

    assert({
      given:
        'attempts 0, 1, 2 and 10 with a fixed random() = 1 (jitter ceiling)',
      should: 'double the base delay per attempt, capped at 30 s, never higher',
      actual: delays,
      expected: [1_000, 2_000, 4_000, 30_000],
    });
  });

  test('random() = 0 always yields a zero-length standard delay', () => {
    assert({
      given: 'full jitter with random() = 0',
      should: 'yield 0 regardless of attempt',
      actual: nextReconnectDelayMs({
        kind: 'standard',
        attempt: 5,
        random: () => 0,
      }),
      expected: 0,
    });
  });

  test('a rate-limited reconnect never falls below the 30 s floor', () => {
    const atFloor = nextReconnectDelayMs({
      kind: 'rate-limited',
      attempt: 0,
      random: () => 0,
    });
    const grown = nextReconnectDelayMs({
      kind: 'rate-limited',
      attempt: 3,
      random: () => 1,
    });

    assert({
      given: 'attempt 0 with random() = 0, and attempt 3 with random() = 1',
      should:
        'stay at the 30 s floor at minimum jitter, and grow above it as attempts rise',
      actual: { atFloor, grownAboveFloor: grown > 30_000 },
      expected: { atFloor: 30_000, grownAboveFloor: true },
    });
  });

  test('an immediate (server-restarting) reconnect is 0-5 s regardless of attempt', () => {
    const delays = [0, 1, 50].map((attempt) =>
      nextReconnectDelayMs({ kind: 'immediate', attempt, random: () => 1 }),
    );

    assert({
      given: 'attempts 0, 1 and 50 with random() = 1 (jitter ceiling)',
      should:
        'always cap at 5 s, independent of attempt (no exponential growth)',
      actual: delays,
      expected: [5_000, 5_000, 5_000],
    });
  });

  test('a negative attempt is treated as attempt 0, never a negative delay', () => {
    assert({
      given: 'attempt -1',
      should: 'clamp to attempt 0 (the 1 s base delay at full jitter)',
      actual: nextReconnectDelayMs({
        kind: 'standard',
        attempt: -1,
        random: () => 1,
      }),
      expected: 1_000,
    });
  });
});
