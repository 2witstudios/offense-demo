import {
  preferenceFromCookies,
  serializeThemeCookie,
  type ThemePreference,
} from './theme-preference';

type Update = () => void;

export type ThemeControllerDeps = {
  /** The preference the page was served with. */
  readonly initial: ThemePreference;
  /** Writes the preference onto the page (DOM and React state). */
  readonly apply: (preference: ThemePreference) => void;
  readonly writeCookie: (cookie: string) => void;
  /** Reads the cookies shared by every tab (`document.cookie`). */
  readonly readCookies: () => string;
  /** Tells the viewer's other tabs that the preference changed. */
  readonly announce: () => void;
  readonly transition: (update: Update) => void;
  readonly secure: boolean;
};

export type ThemeController = {
  readonly select: (preference: ThemePreference) => void;
  /** Catches up with the shared cookie; returns the preference it holds. */
  readonly sync: () => ThemePreference;
};

/**
 * Orders a theme switch's side effects; the provider injects the real ones
 * (effect extraction, docs/development/testing.md).
 */
export const createThemeController = ({
  initial,
  apply,
  writeCookie,
  readCookies,
  announce,
  transition,
  secure,
}: ThemeControllerDeps): ThemeController => {
  let shown = initial;
  // False once a switch could not be saved (cookies blocked): the cookie no
  // longer describes this tab, so it must not overwrite the choice.
  let saved = true;
  const show = (preference: ThemePreference) => {
    shown = preference;
    transition(() => apply(preference));
  };
  return {
    select: (preference) => {
      writeCookie(serializeThemeCookie(preference, { secure }));
      saved = preferenceFromCookies(readCookies()) === preference;
      show(preference);
      if (saved) announce();
    },
    // Announcements carry no value: the shared cookie holds the last write,
    // so a delayed announcement can never apply a stale choice, and a tab
    // that missed one catches up when it is shown again.
    sync: () => {
      if (!saved) return shown;
      const preference = preferenceFromCookies(readCookies());
      if (preference !== shown) show(preference);
      return preference;
    },
  };
};

/** Crossfades a switch with a view transition unless motion is reduced. */
export const createTransition =
  ({
    startViewTransition,
    prefersReducedMotion,
  }: {
    readonly startViewTransition: ((update: Update) => unknown) | undefined;
    readonly prefersReducedMotion: () => boolean;
  }) =>
  (update: Update): void => {
    if (startViewTransition === undefined || prefersReducedMotion()) update();
    else startViewTransition(update);
  };
