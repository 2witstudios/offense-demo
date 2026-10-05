import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { initialLinkForm } from '../auth/request-link';
import { HomeJoin } from './home-join';

setupRitewayBun();

const render = () =>
  renderToString(
    h(HomeJoin, {
      requestLink: () => Promise.resolve(initialLinkForm),
      children: h('h1', null, 'Intro'),
    }),
  );

describe('HomeJoin', () => {
  test('keeps the page introduction above the form', () => {
    const html = render();
    assert({
      given: 'an introduction passed as children',
      should: 'render it once, before the form',
      actual: [
        html.split('<h1>Intro</h1>').length - 1,
        html.indexOf('<h1>Intro</h1>') < html.indexOf('<form'),
      ],
      expected: [1, true],
    });
  });

  test('joins with one email that posts without JavaScript', () => {
    const html = render();
    const form = /<form\b[^>]*>/.exec(html)?.[0] ?? '';
    assert({
      given: 'the home join rendered on the server',
      should:
        'offer one required, labelled email field in a form that never puts the address in a URL',
      actual: [
        /<input[^>]*type="email"[^>]*>/.test(html),
        /\brequired=""/.test(html),
        /<label[^>]*for="sign-in-email"[^>]*>Email<\/label>/.test(html),
        form.includes('method="get"'),
        html.includes('Email me a sign-in link'),
      ],
      expected: [true, true, true, false, true],
    });
  });
});
