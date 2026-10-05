import { renderToString } from 'react-dom/server';
import { createElement as h, Fragment } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Topbar, type ShellAccount } from './topbar';

setupRitewayBun();

const renderWith = (account: ShellAccount = { state: 'anonymous' }): string =>
  renderToString(h(Topbar, { account }));

describe('Topbar', () => {
  test('is the banner with a home brand link and labelled controls', () => {
    const html = renderWith();
    assert({
      given: 'the topbar',
      should: 'render a header and link the brand home',
      actual: [html.includes('<header'), /<a [^>]*href="\/"/.test(html)],
      expected: [true, true],
    });
  });

  test('names the brand link even when its text is hidden at narrow widths', () => {
    const html = renderWith();
    assert({
      given:
        'the brand link, whose logo is aria-hidden and whose wordmark hides at narrow widths',
      should: 'carry its own accessible name',
      // React escapes the name (a display name may hold `&`).
      actual: /<a [^>]*aria-label="([^"]*)"[^>]*href="\/"/.exec(html)?.[1],
      expected: renderToString(h(Fragment, null, 'Offense Demo home')),
    });
  });

  test('offers sign-in to an anonymous visitor', () => {
    const html = renderWith();
    assert({
      given: 'an anonymous visitor',
      should: 'show a Sign in link to /sign-in and no username',
      actual: [/<a [^>]*href="\/sign-in"[^>]*>Sign in</.test(html)],
      expected: [true],
    });
  });

  test('sends a provisional account back to finish sign-up', () => {
    const html = renderWith({ state: 'provisional' });
    assert({
      given: 'an account that has not chosen a username',
      should: 'show a Finish sign-up link to onboarding',
      actual: /<a [^>]*href="\/onboarding\/username"[^>]*>Finish sign-up</.test(
        html,
      ),
      expected: true,
    });
  });

  test('shows the chosen username as the display identity', () => {
    const html = renderWith({ state: 'member', username: 'ada_byron' });
    assert({
      given: 'a member',
      should: 'link their username to settings with an accessible name',
      actual: [
        html.includes('ada_byron'),
        html.includes('aria-label="Account settings for ada_byron"'),
        /href="\/settings"/.test(html),
        html.includes('Sign in<'),
      ],
      expected: [true, true, true, false],
    });
  });
});
