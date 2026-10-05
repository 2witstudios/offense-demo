import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { TabLinks } from './tab-links';
import { tabLinkClass } from './tab-links-class';

setupRitewayBun();

describe('tabLinkClass', () => {
  test('selected and plain', () => {
    assert({
      given: 'a selected and an unselected tab',
      should: 'use the accent underline only when selected',
      actual: [
        tabLinkClass(true).includes('border-accent text-accent'),
        tabLinkClass(false).includes('border-transparent text-ink'),
      ],
      expected: [true, true],
    });
  });
});

describe('TabLinks', () => {
  test('links with the current one marked and counts shown', () => {
    const html = renderToString(
      h(TabLinks, {
        label: 'Status',
        tabs: [
          { id: 'a', label: 'One', href: '/x', selected: true, count: 3 },
          { id: 'b', label: 'Two', href: '/x?tab=b', selected: false },
        ],
      }),
    );
    assert({
      given: 'two tabs, the first selected with a count',
      should: 'be a labelled nav of links, marking only the first current',
      actual: [
        html.includes('aria-label="Status"'),
        html.match(/aria-current="page"/g)?.length,
        html.includes('href="/x?tab=b"'),
        html.includes('>3<'),
      ],
      expected: [true, 1, true, true],
    });
  });
});
