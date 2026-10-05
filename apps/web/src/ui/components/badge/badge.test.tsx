import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Badge } from './badge';

setupRitewayBun();

describe('Badge', () => {
  test('renders its label as a span', () => {
    const html = renderToString(h(Badge, { tone: 'live', children: 'Live' }));
    assert({
      given: 'a live-tone badge',
      should: 'render the label text',
      actual: [html.includes('<span'), html.includes('Live')],
      expected: [true, true],
    });
  });

  test('accepts any tone without changing the markup shape', () => {
    const neutral = renderToString(h(Badge, { children: 'Beta' }));
    const gold = renderToString(h(Badge, { tone: 'gold', children: 'Beta' }));
    assert({
      given: 'the same label with different tones',
      should: 'render the same text content',
      actual: neutral.includes('Beta') && gold.includes('Beta'),
      expected: true,
    });
  });
});
