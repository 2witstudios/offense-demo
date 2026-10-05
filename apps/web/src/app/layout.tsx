import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import { Instrument_Sans } from 'next/font/google';
import { appConfig } from '../app-config';
import { ThemeProvider } from '../ui/theme/theme-provider';
import {
  parseThemePreference,
  THEME_COOKIE,
} from '../ui/theme/theme-preference';
import { sessionRefreshDueNow } from '../lib/request-session';
import { SessionRefresh } from '../ui/auth/session-refresh/session-refresh';
import './globals.css';

// Self-hosted via next/font: same-origin at runtime, CSP-safe, no dependency.
// One face carries both UI and display text; swap it here to rebrand.
const sans = Instrument_Sans({
  variable: '--font-face-sans',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: appConfig.brand.displayName,
    template: `%s · ${appConfig.brand.displayName}`,
  },
  description: appConfig.brand.description,
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Nonce CSP (proxy.ts) requires dynamic rendering: statically prerendered
  // pages are generated at build time without the request nonce, which would
  // block every framework script. Every route renders dynamically today.
  await connection();
  // The cookie is read per request (and validated: it is untrusted), so the
  // served <html> already carries the viewer's theme: no inline script, no
  // flash, no hydration mismatch.
  const jar = await cookies();
  const theme = parseThemePreference(jar.get(THEME_COOKIE)?.value);
  const refreshSession = await sessionRefreshDueNow();
  return (
    <html lang="en" data-theme={theme} className={sans.variable}>
      <body>
        <ThemeProvider initialPreference={theme}>
          {children}
          {refreshSession ? <SessionRefresh /> : null}
        </ThemeProvider>
      </body>
    </html>
  );
}
