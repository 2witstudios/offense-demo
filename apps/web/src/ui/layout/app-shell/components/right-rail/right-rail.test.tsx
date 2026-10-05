import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { RightRail } from './right-rail';

setupRitewayBun();

describe('RightRail', () => {
  test('stacks its sections in order without adding landmarks', () => {
    const html = renderToString(
      h(RightRail, null, h('p', null, 'first'), h('p', null, 'second')),
    );
    assert({
      given: 'two rail sections',
      should: 'render them in order inside a plain div (AppShell owns aside)',
      actual: [
        html.includes('<p>first</p><p>second</p>'),
        html.startsWith('<div'),
        html.includes('<aside'),
      ],
      expected: [true, true, false],
    });
  });
});
