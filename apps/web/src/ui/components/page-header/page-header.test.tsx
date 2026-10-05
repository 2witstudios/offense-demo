import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { PageHeader } from './page-header';

setupRitewayBun();

describe('PageHeader', () => {
  test('title, lede and actions', () => {
    const html = renderToString(
      h(PageHeader, {
        title: 'Reports',
        lede: 'Weekly numbers.',
        actions: h('b', null, 'Offer'),
      }),
    );
    assert({
      given: 'a title, a lede and actions',
      should: 'render one h1, the lede and the actions',
      actual: [
        html.match(/<h1 /g)?.length,
        html.includes('Weekly numbers.'),
        html.includes('<b>Offer</b>'),
      ],
      expected: [1, true, true],
    });
  });

  test('no lede', () => {
    assert({
      given: 'a title alone',
      should: 'render no paragraph',
      actual: renderToString(h(PageHeader, { title: 'Reports' })).includes(
        '<p ',
      ),
      expected: false,
    });
  });
});
