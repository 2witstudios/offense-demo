import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { pageColourClasses } from './stage-palette';

setupRitewayBun();

describe('pageColourClasses', () => {
  test('finds page colours and leaves stage colours and non-colour classes alone', () => {
    assert({
      given: 'markup mixing page ink, a hover accent, stage ink and layout',
      should: 'report only the page-palette colour classes',
      actual: pageColourClasses(
        '<span class="flex text-ink hover:text-accent border-border-strong"></span>' +
          '<i class="text-stage-ink border-stage-ink-muted text-sm bg-surface-stage"></i>',
      ),
      expected: ['text-ink', 'hover:text-accent', 'border-border-strong'],
    });
  });
});
