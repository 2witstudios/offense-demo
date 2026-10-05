/**
 * The viewer's theme preference (ADR 0027): 'dark' and 'light' pin a scheme,
 * 'system' follows prefers-color-scheme through CSS alone. It travels in a
 * plain, non-secret cookie so the server renders the right `data-theme`
 * before first paint.
 */
export const THEME_PREFERENCES = ['dark', 'light', 'system'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_COOKIE = 'offense-demo-theme';

/** No saved choice: Offense Demo is dark-first. */
const DEFAULT_THEME: ThemePreference = 'dark';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export const isThemePreference = (raw: unknown): raw is ThemePreference =>
  THEME_PREFERENCES.some((preference) => preference === raw);

/** Trust boundary for the cookie: unknown values fall back to the default. */
export const parseThemePreference = (raw: unknown): ThemePreference =>
  isThemePreference(raw) ? raw : DEFAULT_THEME;

/**
 * Reads the preference out of a cookie string such as `document.cookie`,
 * through the same trust boundary as the server.
 */
export const preferenceFromCookies = (cookies: string): ThemePreference =>
  parseThemePreference(
    cookies
      .split(';')
      .map((pair) => pair.trim().split('='))
      .find(([name]) => name === THEME_COOKIE)?.[1],
  );

export const serializeThemeCookie = (
  preference: ThemePreference,
  { secure }: { readonly secure: boolean },
): string =>
  [
    `${THEME_COOKIE}=${preference}`,
    'Path=/',
    `Max-Age=${ONE_YEAR_SECONDS}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');

export type ThemeColorEntry = {
  readonly media: string;
  readonly color: string;
};

/** Browser chrome colors; they mirror the --background pair in globals.css (pinned by theme-preference.test.ts). */
const chromeColor = { light: '#f5f6f8', dark: '#0f1117' } as const;

/**
 * One theme-color entry per OS scheme, so the rendered metas keep stable
 * keys across switches; an explicit choice paints both with its own color.
 */
export const themeColorFor = (
  preference: ThemePreference,
): readonly ThemeColorEntry[] =>
  (['light', 'dark'] as const).map((scheme) => ({
    media: `(prefers-color-scheme: ${scheme})`,
    color: chromeColor[preference === 'system' ? scheme : preference],
  }));

export const colorSchemeFor = (
  preference: ThemePreference,
): 'dark' | 'light' | 'light dark' =>
  preference === 'system' ? 'light dark' : preference;
