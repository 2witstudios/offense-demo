import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';

setupRitewayBun();

const stylesheet = join(import.meta.dir, 'globals.css');

/** Compiles the real globals.css with exactly the given candidate classes. */
const compile = async (classes: string): Promise<string> => {
  const source = `${readFileSync(stylesheet, 'utf8')}\n@source inline("${classes}");`;
  const result = await postcss([tailwind() as postcss.AcceptedPlugin]).process(
    source,
    {
      from: stylesheet,
    },
  );
  return result.css;
};

/**
 * The compiled rules, parsed: each selector's declarations and the media
 * query around it, so assertions read values, never substrings.
 */
const rulesOf = (css: string) => {
  const rules = new Map<
    string,
    { media: string | undefined; declarations: Record<string, string> }
  >();
  postcss.parse(css).walkRules((rule) => {
    let media: string | undefined;
    for (
      let node: postcss.Node | undefined = rule.parent;
      node;
      node = node.parent
    )
      if (node.type === 'atrule' && (node as postcss.AtRule).name === 'media')
        media = (node as postcss.AtRule).params;
    const declarations: Record<string, string> = {};
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
    rules.set(rule.selector, { media, declarations });
  });
  return rules;
};

describe('Tailwind theme (ADR 0028)', () => {
  test('generates nothing for default-theme utilities', async () => {
    const css = await compile(
      'bg-red-500 p-7 text-4xl rounded-2xl shadow-md sm:p-4 font-sans',
    );
    assert({
      given:
        'default Tailwind utilities that Offense Demo tokens do not define',
      should: 'emit no rule for any of them',
      actual: [
        '.bg-red-500',
        '.p-7',
        '.text-4xl',
        '.rounded-2xl',
        '.shadow-md',
        '.sm\\:p-4',
        '.font-sans',
      ].filter((selector) => rulesOf(css).has(selector)),
      expected: [],
    });
  });

  test('resolves token utilities through the custom properties', async () => {
    const css = await compile('bg-surface p-4 text-ink-muted shadow-2');
    assert({
      given: 'utilities named after Offense Demo tokens',
      should:
        'emit var() references, so the theme switch needs no class change',
      actual: (() => {
        const rules = rulesOf(css);
        return {
          surface: rules.get('.bg-surface')?.declarations['background-color'],
          padding: rules.get('.p-4')?.declarations.padding,
          muted: rules.get('.text-ink-muted')?.declarations.color,
          shadow: rules.get('.shadow-2')?.declarations['--tw-shadow'],
        };
      })(),
      expected: {
        surface: 'var(--surface)',
        padding: 'var(--spacing-4)',
        muted: 'var(--text-muted)',
        shadow: 'var(--elevation-2)',
      },
    });
  });

  test('keeps the desktop-first ranges as max-* variants', async () => {
    const css = await compile('max-rail:p-2 short:p-2');
    assert({
      given: 'a named breakpoint and the short-viewport variant',
      should:
        'emit a max-width range inclusive of 1100px and a max-height query',
      actual: [
        rulesOf(css).get('.max-rail\\:p-2'),
        rulesOf(css).get('.short\\:p-2'),
      ],
      expected: [
        {
          media: '(width < 1101px)',
          declarations: { padding: 'var(--spacing-2)' },
        },
        {
          media: '(max-height: 660px)',
          declarations: { padding: 'var(--spacing-2)' },
        },
      ],
    });
  });
});
