import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { AppShell } from './app-shell';
import { renderToString } from 'react-dom/server';

setupRitewayBun();

const render = (withRail = true): string =>
  renderToString(
    h(AppShell, {
      account: { state: 'anonymous' },
      ...(withRail ? { rail: h('p', null, 'rail-content') } : {}),
      children: h('p', null, 'page'),
    }),
  );

const occurrences = (html: string, needle: string): number =>
  html.split(needle).length - 1;

describe('AppShell', () => {
  test('owns the single main landmark, as a sibling of header, nav, and aside', () => {
    const html = render();
    assert({
      given: 'the shell, with the root layout rendering no landmark of its own',
      should: 'render exactly one main, one banner, one primary nav, one aside',
      actual: [
        occurrences(html, '<main'),
        occurrences(html, '<header'),
        occurrences(html, '<nav'),
        occurrences(html, '<aside'),
      ],
      expected: [1, 1, 1, 1],
    });
  });

  test('names its landmarks', () => {
    const html = render();
    assert({
      given: 'the shell landmarks',
      should: 'label the navigation "Primary" and the rail "Related"',
      actual: [
        /<nav[^>]* aria-label="Primary"/.test(html),
        /<aside[^>]* aria-label="Related"/.test(html),
      ],
      expected: [true, true],
    });
  });

  test('places children in the content column and the rail in the aside', () => {
    const html = render();
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    assert({
      given: 'page content and rail content',
      should: 'render the page outside the aside and the rail inside it',
      actual: [
        html.includes('<p>page</p>'),
        aside.includes('<p>page</p>'),
        aside.includes('<p>rail-content</p>'),
      ],
      expected: [true, false, true],
    });
  });

  test('omits the rail landmark when no rail is given', () => {
    const html = render(false);
    assert({
      given: 'a shell without rail content',
      should: 'render the page with no aside',
      actual: [html.includes('<p>page</p>'), occurrences(html, '<aside')],
      expected: [true, 0],
    });
  });
});
