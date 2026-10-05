'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { applyTheme } from './apply-theme';
import {
  createThemeController,
  createTransition,
  type ThemeController,
} from './theme-controller';
import {
  colorSchemeFor,
  parseThemePreference,
  themeColorFor,
  type ThemePreference,
} from './theme-preference';

type ThemeContextValue = {
  readonly preference: ThemePreference;
  readonly selectPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const CHANNEL_NAME = 'offense-demo-theme';

export type ThemeProviderProps = {
  /** The request's cookie preference, parsed by the root layout. */
  readonly initialPreference: ThemePreference;
  readonly children: ReactNode;
};

/**
 * Request-scoped theme state (ADR 0027): seeded from the request cookie, so
 * server HTML and the first client render agree. Switches persist to the
 * cookie, crossfade via view transitions, and sync across tabs through a
 * BroadcastChannel.
 */
export function ThemeProvider({
  initialPreference,
  children,
}: ThemeProviderProps) {
  const [preference, setPreference] = useState(initialPreference);
  const controller = useRef<ThemeController | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const next = createThemeController({
      // What the page shows now: the server rendered it from the cookie.
      initial: parseThemePreference(document.documentElement.dataset.theme),
      apply: (chosen) => {
        applyTheme(document.documentElement, chosen);
        // Commit synchronously so the view transition snapshots the
        // switcher's new state too.
        flushSync(() => setPreference(chosen));
      },
      writeCookie: (cookie) => {
        // A plain, non-secret preference cookie; the server re-validates it.
        document.cookie = cookie;
      },
      readCookies: () => document.cookie,
      announce: () => channel.postMessage(null),
      transition: createTransition({
        startViewTransition:
          'startViewTransition' in document
            ? (update) => document.startViewTransition(update)
            : undefined,
        prefersReducedMotion: () => reducedMotion.matches,
      }),
      secure: location.protocol === 'https:',
    });
    const sync = () => next.sync();
    // A frozen or back/forward-cached tab misses announcements; it catches
    // up from the cookie when it is shown again.
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    channel.addEventListener('message', sync);
    document.addEventListener('visibilitychange', syncWhenVisible);
    addEventListener('pageshow', sync);
    controller.current = next;
    return () => {
      controller.current = null;
      channel.close();
      document.removeEventListener('visibilitychange', syncWhenVisible);
      removeEventListener('pageshow', sync);
    };
  }, []);

  const selectPreference = useCallback((chosen: ThemePreference) => {
    controller.current?.select(chosen);
  }, []);

  const value = useMemo(
    () => ({ preference, selectPreference }),
    [preference, selectPreference],
  );

  // React 19 hoists these into <head> and owns them, so browser chrome
  // follows the preference across soft and back/forward navigations.
  return (
    <ThemeContext value={value}>
      <meta name="color-scheme" content={colorSchemeFor(preference)} />
      {themeColorFor(preference).map(({ media, color }) => (
        <meta key={media} name="theme-color" media={media} content={color} />
      ))}
      {children}
    </ThemeContext>
  );
}

export const useThemePreference = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (value === null)
    throw new Error('useThemePreference must be used inside ThemeProvider');
  return value;
};
