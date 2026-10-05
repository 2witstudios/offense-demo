import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { AuthFrame, AuthHeading } from './auth-frame';
import { panelPageColours } from '../../test-support/stage-palette';

setupRitewayBun();

describe('AuthFrame', () => {
  test('keeps the panel free of controls', () => {
    const page = renderToString(
      h(AuthFrame, {
        panel: { eyebrow: 'Why?', title: 'Because.', body: 'Details.' },
        footer: 'Footer line',
        children: h('button', { type: 'button' }, 'Act'),
      }),
    );
    const panel = page.slice(page.indexOf('<aside'));
    assert({
      given: 'a step with a button',
      should:
        'link the logo home, render the panel copy, and keep controls out of the panel',
      actual: [
        page.includes('href="/"'),
        panel.includes('Why?'),
        panel.includes('Because.'),
        panel.includes('Details.'),
        panel.includes('<button'),
        page.includes('Footer line'),
      ],
      expected: [true, true, true, true, false, true],
    });
  });
});

describe('AuthHeading', () => {
  test('renders the eyebrow, the page heading, and the lede', () => {
    const page = renderToString(
      h(AuthHeading, { eyebrow: 'Step', title: 'Title.', children: 'Lede.' }),
    );
    assert({
      given: 'heading copy',
      should: 'use one h1 for the title',
      actual: [
        page.includes('Step'),
        page.match(/<h1/g)?.length,
        page.includes('Lede.'),
      ],
      expected: [true, 1, true],
    });
  });

  test('draws its stage panel in the stage palette', () => {
    const page = renderToString(
      h(AuthFrame, {
        panel: { eyebrow: 'Why?', title: 'Because.', body: 'Details.' },
        children: null,
      }),
    );
    assert({
      given: 'the dark stage panel',
      should: 'use no page-palette colour in its own markup',
      actual: panelPageColours(page),
      expected: [],
    });
  });
});
