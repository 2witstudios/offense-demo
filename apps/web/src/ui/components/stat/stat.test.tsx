import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Stat } from './stat';

setupRitewayBun();

describe('Stat', () => {
  test('renders the value alone by default', () => {
    const html = renderToString(h(Stat, { value: 1820 }));
    assert({
      given: 'a stat with only a value',
      should: 'render the value with no icon',
      actual: [html.includes('>1820<'), html.includes('<svg')],
      expected: [true, false],
    });
  });

  test('adds a decorative icon and a label when provided', () => {
    const html = renderToString(
      h(Stat, { value: 1820, icon: 'chart', label: 'rating' }),
    );
    assert({
      given: 'a stat with icon and label',
      should: 'render the icon hidden from readers, then value, then label',
      actual: [
        html.includes('aria-hidden="true"'),
        html.indexOf('<svg') < html.indexOf('>1820<'),
        html.indexOf('>1820<') < html.indexOf('>rating<'),
        html.includes('>rating<'),
      ],
      expected: [true, true, true, true],
    });
  });
});
