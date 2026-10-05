import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { PRIVACY_VERSION, TERMS_VERSION } from './versions';

setupRitewayBun();

describe('legal versions', () => {
  test('start at draft-0', () => {
    assert({
      given: 'the current terms and privacy versions',
      should: 'both be draft-0',
      actual: [TERMS_VERSION, PRIVACY_VERSION],
      expected: ['draft-0', 'draft-0'],
    });
  });
});
