import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { buttonClass } from '../ui/components/button/button-class';
import ErrorBoundary from './error';

setupRitewayBun();

describe('ErrorBoundary', () => {
  test('offers the retry as a styled button', () => {
    const html = renderToString(
      h(ErrorBoundary, {
        error: Object.assign(new Error('boom'), { digest: 'd1' }),
        retry: () => undefined,
      }),
    );
    assert({
      given: 'a route error, under the Tailwind base reset',
      should: 'render "Try again" with the primary button classes',
      actual: /<button[^>]* class="([^"]*)"[^>]*>Try again<\/button>/.exec(
        html,
      )?.[1],
      expected: buttonClass('primary'),
    });
  });
});
