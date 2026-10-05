import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  checkArchitectureExceptions,
  findArchitectureExceptionMarkers,
  type ArchitectureException,
} from './architecture-exceptions';

setupRitewayBun();

const exception: ArchitectureException = {
  id: 'AGT-7.1',
  owner: 'platform',
  reason: 'The boundary checker requires direct filesystem access.',
  expires: '2026-09-20',
};

describe('architecture exception registry', () => {
  test('accepts a registered marker before its expiry', () => {
    assert({
      given:
        'a registered architecture exception whose expiry is in the future',
      should: 'report no architecture exception issues',
      actual: checkArchitectureExceptions(
        [exception],
        ['AGT-7.1'],
        '2026-09-19',
      ),
      expected: [],
    });
  });

  test('rejects a marker after its registry expiry', () => {
    assert({
      given: 'a registered architecture exception whose expiry has passed',
      should: 'report that the exception is expired',
      actual: checkArchitectureExceptions(
        [exception],
        ['AGT-7.1'],
        '2026-09-21',
      ),
      expected: ['architecture exception AGT-7.1 expired on 2026-09-20'],
    });
  });

  test('rejects markers without a registry entry', () => {
    assert({
      given: 'a source marker absent from the architecture exception registry',
      should: 'report the unknown marker',
      actual: checkArchitectureExceptions([], ['AGT-7.1'], '2026-09-19'),
      expected: ['architecture exception AGT-7.1 is not registered'],
    });
  });

  test('extracts distinct architecture exception markers from source', () => {
    assert({
      given: 'source containing repeated architecture exception comments',
      should: 'return each marker once',
      actual: findArchitectureExceptionMarkers(
        '// architecture-exception: AGT-7.1\n// architecture-exception: AGT-7.1',
      ),
      expected: ['AGT-7.1'],
    });
  });
});
