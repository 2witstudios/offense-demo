'use client';

import { useState } from 'react';
import { Button } from '../ui/components/button/button';
import { prose } from './ui/prose-class';
import { preferenceFromCookies } from '../ui/theme/theme-preference';
import { appConfig } from '../app-config';
import './globals.css';

/**
 * Replaces the root layout entirely (Next 16 docs: global-error must define
 * its own <html> and <body>, and gets none of the layout's ThemeProvider or
 * fonts), so it reads the theme cookie itself to avoid flashing the OS
 * default scheme over a request the viewer already chose a theme for.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const [theme] = useState(() =>
    typeof document === 'undefined'
      ? 'dark'
      : preferenceFromCookies(document.cookie),
  );
  return (
    <html lang="en" data-theme={theme}>
      <body>
        <title>{`Something went wrong · ${appConfig.brand.displayName}`}</title>
        <main>
          <h1 className={prose.h1}>Something went wrong</h1>
          <p className={prose.p}>
            This failure was recorded with correlation identifier{' '}
            {error.digest ?? 'unknown'}.
          </p>
          <Button onClick={retry}>Try again</Button>
        </main>
      </body>
    </html>
  );
}
