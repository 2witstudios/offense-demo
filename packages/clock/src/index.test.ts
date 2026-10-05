import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  fixedClock,
  fixedIds,
  sequentialId,
  systemClock,
  systemId,
} from './index';

setupRitewayBun();

describe('clock and identity primitives', () => {
  test('fixed clock returns the injected instant without ambient reads', () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z');

    assert({
      given: 'a fixed UTC instant',
      should: 'return that instant for every read',
      actual: [clock.now(), clock.now()],
      expected: ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    });
  });

  test('sequential identity returns stable ordered identities', () => {
    const ids = sequentialId('test');

    assert({
      given: 'a deterministic identity generator',
      should: 'return sequential identities from its configured prefix',
      actual: [ids.next(), ids.next(), ids.next()],
      expected: ['test-1', 'test-2', 'test-3'],
    });
  });

  test('fixed identities return the configured ordered identities', () => {
    const ids = fixedIds(['first', 'second']);

    assert({
      given: 'a deterministic identity list',
      should: 'return each configured identity in order',
      actual: [ids.next(), ids.next()],
      expected: ['first', 'second'],
    });
  });

  test('system implementations expose the primitive contracts', () => {
    const timestamp = systemClock.now();
    const id = systemId.next();

    assert({
      given: 'the system clock and identity implementations',
      should: 'provide an ISO timestamp and an unguessable cuid2 identity',
      actual: [expectIsoTimestamp(timestamp), expectCuid2(id)],
      expected: [true, true],
    });
  });
});

function expectIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function expectCuid2(value: string): boolean {
  return /^[a-z0-9]{24}$/.test(value);
}
