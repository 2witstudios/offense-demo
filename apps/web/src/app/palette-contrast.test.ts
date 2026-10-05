import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  rootTokens,
  schemeValue,
  type Scheme,
} from '../ui/test-support/globals-tokens';

setupRitewayBun();

/** WCAG 2.2 AA: body text 4.5:1, UI components and graphics 3:1. */
const TEXT = 4.5;
const UI = 3;

type Rgba = readonly [r: number, g: number, b: number, a: number];

const parseColor = (value: string): Rgba => {
  const hex = /^#([\da-f]{6})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    const n = Number.parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)?.[1];
  if (rgba !== undefined) {
    const [r = 0, g = 0, b = 0, a = 1] = rgba.split(',').map(Number);
    return [r, g, b, a];
  }
  throw new Error(`unsupported colour: ${value}`);
};

/** A translucent colour laid over an opaque one. */
const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [
  r * a + br * (1 - a),
  g * a + bg * (1 - a),
  b * a + bb * (1 - a),
  1,
];

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgba): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrast = (a: Rgba, b: Rgba): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

/**
 * A declared pairing: `fg` drawn on `bg`, where `bg` may be a translucent
 * token laid over the opaque `base`.
 */
type Pair = {
  readonly fg: string;
  readonly bg: string;
  readonly base?: string;
  readonly min: number;
};

type Tokens = ReadonlyMap<string, string>;

const colourOf = (tokens: Tokens, name: string, scheme: Scheme): Rgba => {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`no token ${name}`);
  return parseColor(schemeValue(value, scheme));
};

const ratioOf = (tokens: Tokens, pair: Pair, scheme: Scheme): number => {
  const bg = colourOf(tokens, pair.bg, scheme);
  const backdrop =
    pair.base === undefined
      ? bg
      : over(bg, colourOf(tokens, pair.base, scheme));
  return contrast(over(colourOf(tokens, pair.fg, scheme), backdrop), backdrop);
};

/** Every pairing below its minimum, in either scheme, with its ratio. */
const failingPairs = (tokens: Tokens, pairs: readonly Pair[]) =>
  (['light', 'dark'] as const).flatMap((scheme) =>
    pairs
      .map((pair) => ({ pair, ratio: ratioOf(tokens, pair, scheme) }))
      .filter(({ pair, ratio }) => ratio < pair.min)
      .map(
        ({ pair, ratio }) =>
          `${scheme}: ${pair.fg} on ${pair.bg}${pair.base ? ` over ${pair.base}` : ''} is ${ratio.toFixed(2)}, needs ${pair.min}`,
      ),
  );

const pageSurfaces = [
  '--background',
  '--surface',
  '--surface-raised',
  '--surface-overlay',
  '--surface-sunken',
] as const;

const on = (
  fgs: readonly string[],
  bgs: readonly string[],
  min: number,
): readonly Pair[] => fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, min })));

/**
 * The declared pairings: every place a text or UI token is drawn on a
 * surface in the app (`text-ink-faint` on `bg-surface-sunken`, the
 * `bg-live-soft text-live` badge, the accent button's ink). A new pairing in
 * markup is declared here.
 */
const declaredPairs: readonly Pair[] = [
  ...on(['--text', '--text-muted', '--text-faint'], pageSurfaces, TEXT),
  // Links, accent labels, status and honour text sit on the page's cards.
  ...on(
    ['--accent', '--accent-strong', '--live', '--gold'],
    ['--background', '--surface', '--surface-raised'],
    TEXT,
  ),
  { fg: '--accent-text', bg: '--accent', min: TEXT },
  { fg: '--accent-text', bg: '--accent-strong', min: TEXT },
  // Tinted badges and the active nav item.
  ...on(['--accent', '--accent-strong'], ['--accent-soft'], TEXT).flatMap(
    (pair) =>
      ['--surface', '--surface-raised'].map((base) => ({ ...pair, base })),
  ),
  { fg: '--live', bg: '--live-soft', base: '--surface', min: TEXT },
  { fg: '--gold', bg: '--gold-soft', base: '--surface', min: TEXT },
  // The stage is dark in both schemes and carries its own ink.
  ...on(['--stage-text', '--stage-text-muted'], ['--surface-stage'], TEXT),
  { fg: '--stage-accent-text', bg: '--stage-accent', min: TEXT },
  { fg: '--stage-accent-text', bg: '--stage-accent-strong', min: TEXT },
  // UI: the focus ring, presence, live and away dots, the accent button (and
  // the brand mark) against the page, and the stage button against the stage.
  ...on(['--accent', '--online', '--live', '--gold'], pageSurfaces, UI),
  { fg: '--stage-accent', bg: '--surface-stage', min: UI },
  // The mark's disc reads on its square.
  { fg: '--accent-text', bg: '--accent', min: UI },
];

describe('palette contrast', () => {
  test('meets WCAG AA for every declared pair in both schemes', () => {
    assert({
      given: 'each declared text and UI pairing in the light and dark schemes',
      should: 'reach 4.5:1 for text and 3:1 for UI',
      actual: failingPairs(rootTokens(), declaredPairs),
      expected: [],
    });
  });

  test('fails when a token regresses', () => {
    const tokens = new Map(rootTokens());
    tokens.set('--text-faint', 'light-dark(#c9c4b6, #2a3a30)');
    assert({
      given: 'a faint ink moved close to its surfaces in both schemes',
      should: 'report the failing pairs',
      actual: failingPairs(tokens, [
        { fg: '--text-faint', bg: '--background', min: TEXT },
      ]).map((failure) => failure.split(' is ')[0]),
      expected: [
        'light: --text-faint on --background',
        'dark: --text-faint on --background',
      ],
    });
  });

  test('measures known WCAG ratios', () => {
    const [white, black, grey] = ['#ffffff', '#000000', '#767676'].map(
      parseColor,
    ) as [Rgba, Rgba, Rgba];
    assert({
      given: 'black on white, mid grey on white, and half-transparent black',
      should: 'give 21, the 4.54 AA threshold grey, and a composited grey',
      actual: [
        contrast(black, white).toFixed(2),
        contrast(grey, white).toFixed(2),
        over(parseColor('rgba(0, 0, 0, 0.5)'), white).map(Math.round),
      ],
      expected: ['21.00', '4.54', [128, 128, 128, 1]],
    });
  });
});
