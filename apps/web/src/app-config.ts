import type { Requirement } from './features/access/decision';

/**
 * The one place a new project customizes the web app's identity and shape:
 * its brand copy, the primary navigation, which areas need an account, and
 * where a signed-in visitor lands. Everything here is static data; the
 * modules that read it (layout metadata, topbar, sidebar, mail, the confirm
 * pages, passkey registration, the access decision) stay pure.
 *
 * The palette lives in `app/globals.css` (light and dark tokens, ADR 0027);
 * `features/auth/brand-palette.ts` mirrors it for the surfaces served outside
 * the Next CSS pipeline, and `brand-palette.test.ts` keeps the two equal.
 */
export const appConfig = {
  brand: {
    /** Product name: page titles, the wordmark, mail, passkey `rpName`. */
    displayName: 'Offense Demo',
    /** One line under the name: the home page and auth panel. */
    tagline: 'A dependable starting point for your next product.',
    /** `<meta name="description">` for every page that sets none. */
    description:
      'Offense Demo: passwordless accounts, realtime rooms and a typed foundation.',
  },
  mail: {
    /** Closing line under every account email. */
    footerNote:
      'Offense Demo never asks for your password by email because you do not have one — every sign-in works through a link or a passkey.',
  },
  /** Where a signed-in visitor goes when nothing asked for elsewhere. */
  homeRoute: '/app',
  /** The sidebar's primary navigation, in order. Icons name `ui/components/icon` shapes. */
  navigation: [
    { href: '/', icon: 'home', label: 'Home' },
    { href: '/app', icon: 'bolt', label: 'App' },
    { href: '/settings', icon: 'key', label: 'Settings' },
  ],
  /**
   * Areas that need an account, and what each needs (see `Requirement`).
   * Absent paths stay public; descendants inherit the longest matching entry.
   */
  guardedAreas: {
    '/app': 'participant',
    '/settings': 'account',
  },
} as const satisfies {
  readonly brand: {
    readonly displayName: string;
    readonly tagline: string;
    readonly description: string;
  };
  readonly mail: { readonly footerNote: string };
  readonly homeRoute: string;
  readonly navigation: ReadonlyArray<{
    readonly href: string;
    readonly icon: string;
    readonly label: string;
  }>;
  readonly guardedAreas: Readonly<Record<string, Requirement>>;
};
