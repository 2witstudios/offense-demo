import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { ThemeProvider, useThemePreference } from './theme-provider';
import type { ThemePreference } from './theme-preference';

setupRitewayBun();

function Probe() {
  const { preference } = useThemePreference();
  return h('p', null, preference);
}

/** What the consumer rendered, without the provider's own <meta> tags. */
const probed = (initialPreference: ThemePreference) =>
  /<p>([^<]*)<\/p>/.exec(
    renderToString(h(ThemeProvider, { initialPreference, children: h(Probe) })),
  )?.[1];

describe('ThemeProvider', () => {
  test('serves the request preference to the first render', () => {
    assert({
      given: 'a provider seeded with the light preference',
      should: 'render consumers with light on the server',
      actual: probed('light'),
      expected: 'light',
    });
  });

  test('keeps concurrent requests apart', () => {
    assert({
      given: 'two providers rendered with different preferences',
      should: 'render each with its own preference',
      actual: [probed('system'), probed('dark')],
      expected: ['system', 'dark'],
    });
  });

  test('renders the browser chrome metas for the preference', () => {
    const metas = (initialPreference: ThemePreference) =>
      [
        ...renderToString(
          h(ThemeProvider, { initialPreference, children: null }),
        ).matchAll(/<meta ([^>]*?)\/?>/g),
      ].map((match) => match[1]);
    assert({
      given: 'the light and system preferences',
      should:
        'render the color-scheme meta and one theme-color meta per OS scheme',
      actual: [metas('light'), metas('system')],
      expected: [
        [
          'name="color-scheme" content="light"',
          'name="theme-color" media="(prefers-color-scheme: light)" content="#f5f6f8"',
          'name="theme-color" media="(prefers-color-scheme: dark)" content="#f5f6f8"',
        ],
        [
          'name="color-scheme" content="light dark"',
          'name="theme-color" media="(prefers-color-scheme: light)" content="#f5f6f8"',
          'name="theme-color" media="(prefers-color-scheme: dark)" content="#0f1117"',
        ],
      ],
    });
  });

  test('rejects a consumer outside the provider', () => {
    expect(() => renderToString(h(Probe))).toThrow(
      'useThemePreference must be used inside ThemeProvider',
    );
  });
});
