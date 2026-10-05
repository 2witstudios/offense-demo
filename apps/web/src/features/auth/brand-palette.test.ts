import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, setupRitewayBun, test } from 'riteway/bun';
import { AUTH_BRAND_PALETTE } from './brand-palette';

setupRitewayBun();

const GLOBALS_CSS_PATH = join(import.meta.dir, '../../app/globals.css');

/** Every `--token: light-dark(<light>, <dark>);` declaration in globals.css. */
function readGlobalsTokens(): Record<string, { light: string; dark: string }> {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf8');
  const tokens: Record<string, { light: string; dark: string }> = {};
  for (const match of css.matchAll(
    /--([a-z-]+):\s*light-dark\(([^,]+),\s*([^)]+)\);/g,
  ))
    tokens[match[1] as string] = {
      light: (match[2] as string).trim(),
      dark: (match[3] as string).trim(),
    };
  return tokens;
}

/** Maps a globals.css token name to the brand-palette key that must equal it. */
const SHARED_TOKENS: Record<string, keyof typeof AUTH_BRAND_PALETTE.light> = {
  background: 'background',
  'surface-stage': 'surfaceStage',
  'stage-text': 'stageInk',
  'stage-text-muted': 'stageInkMuted',
  'stage-accent': 'stageAccent',
  'surface-raised': 'surfaceRaised',
  text: 'ink',
  'text-muted': 'inkMuted',
  border: 'border',
  accent: 'accent',
  'accent-strong': 'accentStrong',
  'accent-text': 'accentInk',
};

test('brand-palette.ts stays equal to globals.css for every shared token', () => {
  const tokens = readGlobalsTokens();
  const mismatches = Object.entries(SHARED_TOKENS).flatMap(
    ([cssName, paletteKey]) => {
      const token = tokens[cssName];
      if (!token) return [`${cssName} missing from globals.css`];
      const problems: string[] = [];
      if (token.light !== AUTH_BRAND_PALETTE.light[paletteKey])
        problems.push(
          `${cssName} light: css=${token.light} palette=${AUTH_BRAND_PALETTE.light[paletteKey]}`,
        );
      if (token.dark !== AUTH_BRAND_PALETTE.dark[paletteKey])
        problems.push(
          `${cssName} dark: css=${token.dark} palette=${AUTH_BRAND_PALETTE.dark[paletteKey]}`,
        );
      return problems;
    },
  );
  assert({
    given: 'globals.css and brand-palette.ts',
    should: 'agree on every shared color token, in both themes',
    actual: mismatches,
    expected: [],
  });
});

test('brand-palette.ts negative control: a real drift is caught', () => {
  const tokens = readGlobalsTokens();
  const drifted = { ...AUTH_BRAND_PALETTE.light, accent: '#000000' };
  assert({
    given: 'a palette value deliberately moved away from globals.css',
    should: 'no longer equal the css token',
    actual: drifted.accent === tokens.accent?.light,
    expected: false,
  });
});
