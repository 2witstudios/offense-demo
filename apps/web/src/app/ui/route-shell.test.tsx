import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { RouteShell } from './route-shell';

setupRitewayBun();

const textsOf = (html: string, tag: string): readonly string[] =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map(
    (match) => match[1] ?? '',
  );

const html = renderToString(
  h(RouteShell, {
    title: 'Reports',
    lede: 'Numbers that matter.',
    planned: ['Dashboards', 'Exports', 'Alerts'],
  }),
);

describe('RouteShell', () => {
  test('titles the page with a single h1 and shows the lede', () => {
    assert({
      given: 'a title and a lede',
      should: 'render the title as the only h1 and the lede as text',
      actual: [textsOf(html, 'h1'), html.includes('Numbers that matter.')],
      expected: [['Reports'], true],
    });
  });

  test('lists the planned capabilities in order', () => {
    assert({
      given: 'three planned capabilities',
      should: 'render each as a list item, in the order given',
      actual: textsOf(html, 'li'),
      expected: ['Dashboards', 'Exports', 'Alerts'],
    });
  });
});
