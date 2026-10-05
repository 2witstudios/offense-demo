import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Icon } from './icon';

setupRitewayBun();

describe('Icon', () => {
  test('renders decorative by default', () => {
    const html = renderToString(h(Icon, { name: 'swords' }));
    assert({
      given: 'an icon without a label',
      should: 'hide from assistive technology',
      actual: html.includes('aria-hidden="true"'),
      expected: true,
    });
  });

  test('exposes a labelled icon as an image role', () => {
    const html = renderToString(h(Icon, { name: 'trophy', label: 'Prize' }));
    assert({
      given: 'an icon with a label',
      should: 'render an image role with the accessible name',
      actual: [
        html.includes('role="img"'),
        html.includes('aria-label="Prize"'),
      ],
      expected: [true, true],
    });
  });

  test('renders the requested path data at the requested size', () => {
    const html = renderToString(h(Icon, { name: 'bell', size: 28 }));
    assert({
      given: 'a bell icon at size 28',
      should: 'use the bell path and the 28px box',
      actual: [
        html.includes('M6 8a6 6 0 0 1 12 0'),
        html.includes('width="28"'),
      ],
      expected: [true, true],
    });
  });
});
