import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { stylingIssues } from './check-styling';

setupRitewayBun();

describe('styling gate', () => {
  test('rejects a CSS Module anywhere', () => {
    assert({
      given: 'a component stylesheet named like a CSS Module',
      should: 'report it',
      actual: stylingIssues(['apps/web/src/ui/panel/panel.module.css']).length,
      expected: 1,
    });
  });

  test('rejects a Tailwind config file in every flavor', () => {
    assert({
      given: 'js, mjs, cjs, ts and nested Tailwind config files',
      should: 'report each',
      actual: stylingIssues([
        'tailwind.config.js',
        'tailwind.config.mjs',
        'tailwind.config.cjs',
        'apps/web/tailwind.config.ts',
      ]).length,
      expected: 4,
    });
  });

  test('accepts the CSS-only setup', () => {
    assert({
      given: 'the global stylesheet, theme partials and postcss config',
      should: 'report nothing',
      actual: stylingIssues([
        'apps/web/src/app/globals.css',
        'apps/web/src/app/theme/reset.css',
        'apps/web/postcss.config.mjs',
        'docs/tailwind.config.md',
      ]),
      expected: [],
    });
  });
});
