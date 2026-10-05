import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Panel } from './panel';
import { Button } from '../button/button';

setupRitewayBun();

describe('Panel', () => {
  test('renders a titled panel body', () => {
    const html = renderToString(
      h(Panel, {
        title: 'Recent Activity',
        children: h('p', null, 'body'),
      }),
    );
    assert({
      given: 'a titled panel',
      should: 'render a heading followed by the body',
      actual: [html.includes('Recent Activity'), html.includes('<p>body</p>')],
      expected: [true, true],
    });
  });

  test('renders the trailing header action when provided', () => {
    const html = renderToString(
      h(Panel, {
        title: 'Online',
        action: h(Button, { variant: 'ghost', children: 'See All' }),
        children: h('p', null, 'body'),
      }),
    );
    assert({
      given: 'a panel with a header action',
      should: 'render the action in the header',
      actual: html.includes('See All'),
      expected: true,
    });
  });

  test('sets the title as a quiet eyebrow heading', () => {
    const html = renderToString(
      h(Panel, { title: 'Online', children: h('p', null, 'b') }),
    );
    assert({
      given: 'a panel title',
      should: 'render it as an uppercase h2 with no border on the card',
      actual: [
        /<h2[^>]*uppercase[^>]*>Online<\/h2>/.test(html),
        html.includes('border'),
      ],
      expected: [true, false],
    });
  });
});
