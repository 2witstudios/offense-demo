import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Button } from './button';

setupRitewayBun();

describe('Button', () => {
  test('renders children as a button by default', () => {
    const html = renderToString(h(Button, { children: 'Register' }));
    assert({
      given: 'a button without props',
      should: 'render the label inside a button element',
      actual: [
        html.includes('Register'),
        html.includes('<button'),
        html.includes('type="button"'),
      ],
      expected: [true, true, true],
    });
  });

  test('forwards native attributes', () => {
    const html = renderToString(
      h(Button, { type: 'submit', disabled: true, children: 'Register' }),
    );
    assert({
      given: 'a disabled submit button',
      should: 'forward the native attributes',
      actual: [html.includes('disabled'), html.includes('type="submit"')],
      expected: [true, true],
    });
  });
});
