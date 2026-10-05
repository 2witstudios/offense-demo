import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  colorSchemeFor,
  isThemePreference,
  parseThemePreference,
  preferenceFromCookies,
  serializeThemeCookie,
  THEME_COOKIE,
  THEME_PREFERENCES,
  themeColorFor,
} from './theme-preference';
import { rootTokens, schemeValue } from '../test-support/globals-tokens';

setupRitewayBun();

describe('parseThemePreference', () => {
  test('accepts every known preference', () => {
    assert({
      given: 'each known preference string',
      should: 'return it unchanged',
      actual: THEME_PREFERENCES.map(parseThemePreference),
      expected: ['dark', 'light', 'system'],
    });
  });

  test('falls back to dark for anything else', () => {
    assert({
      given: 'a missing cookie, wrong case, junk, and non-strings',
      should: 'default to the dark theme',
      actual: [undefined, 'Light', 'sepia', '', 1, null].map(
        parseThemePreference,
      ),
      expected: ['dark', 'dark', 'dark', 'dark', 'dark', 'dark'],
    });
  });
});

describe('isThemePreference', () => {
  test('recognizes only known preferences', () => {
    assert({
      given: 'a known value, a near miss, and a non-string',
      should: 'accept only the known value',
      actual: ['system', 'System', {}].map(isThemePreference),
      expected: [true, false, false],
    });
  });
});

describe('preferenceFromCookies', () => {
  test('finds the theme among other cookies', () => {
    assert({
      given: 'a cookie string holding several cookies',
      should: 'return the theme preference',
      actual: preferenceFromCookies('a=1; offense-demo-theme=light; b=2'),
      expected: 'light',
    });
  });

  test('validates what it finds', () => {
    assert({
      given: 'no theme cookie, a tampered value, and a look-alike name',
      should: 'fall back to dark each time',
      actual: [
        '',
        'offense-demo-theme=sepia',
        'not-offense-demo-theme=light',
      ].map(preferenceFromCookies),
      expected: ['dark', 'dark', 'dark'],
    });
  });
});

describe('serializeThemeCookie', () => {
  test('writes a year-long, site-wide, lax cookie', () => {
    assert({
      given: 'the light preference over plain http',
      should: 'serialize a cookie without the Secure flag',
      actual: serializeThemeCookie('light', { secure: false }),
      expected: `${THEME_COOKIE}=light; Path=/; Max-Age=31536000; SameSite=Lax`,
    });
  });

  test('marks the cookie Secure over https', () => {
    assert({
      given: 'the system preference over https',
      should: 'append the Secure flag',
      actual: serializeThemeCookie('system', { secure: true }),
      expected: `${THEME_COOKIE}=system; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    });
  });
});

const lightQuery = '(prefers-color-scheme: light)';
const darkQuery = '(prefers-color-scheme: dark)';

describe('themeColorFor', () => {
  test('paints both OS schemes with an explicit choice', () => {
    assert({
      given: 'the dark and light preferences',
      should: 'return the same chosen color for both media queries',
      actual: [themeColorFor('dark'), themeColorFor('light')],
      expected: [
        [
          { media: lightQuery, color: '#0f1117' },
          { media: darkQuery, color: '#0f1117' },
        ],
        [
          { media: lightQuery, color: '#f5f6f8' },
          { media: darkQuery, color: '#f5f6f8' },
        ],
      ],
    });
  });

  test('follows the OS scheme for the system preference', () => {
    assert({
      given: 'the system preference',
      should: 'return each scheme its own color',
      actual: themeColorFor('system'),
      expected: [
        { media: lightQuery, color: '#f5f6f8' },
        { media: darkQuery, color: '#0f1117' },
      ],
    });
  });
});

describe('themeColorFor and globals.css', () => {
  test('mirror the --background pair', () => {
    const background = rootTokens().get('--background') ?? '';
    const [light, dark] = themeColorFor('system').map(({ color }) => color);
    assert({
      given: 'the system chrome colors and the page background token',
      should: "paint each OS scheme with that scheme's background",
      actual: [light, dark],
      expected: [
        schemeValue(background, 'light'),
        schemeValue(background, 'dark'),
      ],
    });
  });
});

describe('colorSchemeFor', () => {
  test('maps each preference to its supported color schemes', () => {
    assert({
      given: 'each preference',
      should: 'return the matching color-scheme value',
      actual: THEME_PREFERENCES.map(colorSchemeFor),
      expected: ['dark', 'light', 'light dark'],
    });
  });
});
