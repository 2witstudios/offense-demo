import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { EmailChangeForm } from './email-change-form';

setupRitewayBun();

describe('EmailChangeForm', () => {
  test('renders a form the browser can post without JavaScript', () => {
    const page = renderToString(
      h(EmailChangeForm, { action: async (state) => state }),
    );
    const tag = (name: string) =>
      page.match(new RegExp(`<${name}\\b[^>]*>`))?.[0] ?? '';
    assert({
      given: 'the server render, before anything is typed',
      should:
        'post the address as a required newEmail field with an enabled submit, never by GET',
      actual: [
        tag('input').includes('name="newEmail"'),
        tag('input').includes(' required=""'),
        tag('button').includes(' disabled=""'),
        /method="get"/i.test(tag('form')),
      ],
      expected: [true, true, false, false],
    });
  });
});
