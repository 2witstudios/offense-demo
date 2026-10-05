import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { AUTH_BRAND_PALETTE } from '../brand-palette';
import {
  inlineColoursWithoutDarkOverride,
  parseDarkRules,
  parseElements,
  resolved,
  type Theme,
} from './rendered-mail.test-support';
import { renderAuthEmail } from './templates';

setupRitewayBun();

const rendered = renderAuthEmail({
  kind: 'sign-in',
  url: 'https://offense-demo.example.com/auth/confirm?token=abc',
}).html;

/** sRGB hex → relative luminance (WCAG 2.x). */
function relativeLuminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two sRGB hex colors, 1 (none) to 21 (max). */
function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

const elements = parseElements(rendered);
const darkRules = parseDarkRules(rendered);

/** Every element that paints visible text (the hidden preheader excluded). */
const visibleText = elements.filter(
  (element) =>
    element.text.replaceAll('&nbsp;', '').trim() !== '' &&
    element.style.display !== 'none',
);

/** Text runs whose color on their backdrop falls under WCAG AA (4.5:1). */
function contrastFailures(theme: Theme): string[] {
  return visibleText.flatMap((element) => {
    const color = resolved(element, 'color', theme, darkRules);
    const backdrop = resolved(element, 'background', theme, darkRules);
    if (!color || !backdrop)
      return [`<${element.tag}> "${element.text.trim()}" has no color`];
    const ratio = contrastRatio(color, backdrop);
    return ratio >= 4.5
      ? []
      : [
          `<${element.tag}> "${element.text.trim()}" ${color} on ${backdrop} is ${ratio.toFixed(2)}:1`,
        ];
  });
}

describe('AUTH-3.9 auth email layout: width, dark mode and contrast (ISSUE-167)', () => {
  test('keeps the message surface fluid up to a 600px cap', () => {
    const surface = elements.find(
      (element) =>
        element.tag === 'table' &&
        element.classes.includes('auth-mail-surface'),
    );
    assert({
      given: 'the rendered message surface',
      should: 'fill the viewport width and stop at 600px',
      actual: {
        width: surface?.style.width,
        maxWidth: surface?.style['max-width'],
      },
      expected: { width: '100%', maxWidth: '600px' },
    });
  });

  test('paints the brand dot with the dark accent in a dark client', () => {
    const dot = elements.find((element) =>
      element.classes.includes('auth-mail-accent-bg'),
    );
    assert({
      given: 'the brand dot, whose light accent is set inline',
      should: 'resolve to the dark accent under prefers-color-scheme: dark',
      actual: dot && resolved(dot, 'background', 'dark', darkRules),
      expected: AUTH_BRAND_PALETTE.dark.accent,
    });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`every visible ${theme}-mode text run meets WCAG AA (4.5:1) on its backdrop`, () => {
      assert({
        given: `the rendered email's text as a ${theme}-mode client paints it`,
        should: 'each run reach at least a 4.5:1 contrast ratio',
        actual: contrastFailures(theme),
        expected: [],
      });
    });
  }
});

describe('reading the dark block: an inline style beats a rule without !important', () => {
  /** A minimal email whose dark rules differ only in `!important`. */
  const email = (important: string) => `<html><head><style>
  @media (prefers-color-scheme: dark) {
    .dot { background: #000000${important}; }
  }
</style></head>
<body><table><tr><td class="dot" style="background:#ffffff;">x</td></tr></table></body></html>`;

  test('a dark rule without !important does not override an inline colour', () => {
    const html = email('');
    const [dot] = parseElements(html).filter((element) =>
      element.classes.includes('dot'),
    );
    assert({
      given:
        'an inline light background and a matching dark rule without !important',
      should:
        'keep the inline value in dark mode and report the colour as not overridden',
      actual: {
        dark: dot && resolved(dot, 'background', 'dark', parseDarkRules(html)),
        missing: inlineColoursWithoutDarkOverride(html),
      },
      expected: { dark: '#ffffff', missing: ['<td class="dot"> background'] },
    });
  });

  test('a dark rule with !important overrides an inline colour', () => {
    const html = email(' !important');
    const [dot] = parseElements(html).filter((element) =>
      element.classes.includes('dot'),
    );
    assert({
      given: 'an inline light background and a matching !important dark rule',
      should: 'resolve to the dark value and report nothing missing',
      actual: {
        dark: dot && resolved(dot, 'background', 'dark', parseDarkRules(html)),
        missing: inlineColoursWithoutDarkOverride(html),
      },
      expected: { dark: '#000000', missing: [] },
    });
  });
});
