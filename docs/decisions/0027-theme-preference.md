# 0027: Theme preference

Status: accepted. Amended ADR 0024 (the in-house UI shell store, removed
from the template): the theme left the module-level UI store.

## Context

The palette and UI are not final, but the light/dark mechanics have to exist
before more surfaces are built on top of the tokens. The first version kept a
`themeColor` resource in the module-level shell store. `<html>` shipped a
hard-coded `data-theme="dark"`, and a client effect copied the store value
onto it. That design had three problems:

- A module-level store is shared across server requests, so a per-viewer
  preference cannot live there.
- There was no saved preference and no way to follow the OS scheme.
- Any saved preference would flash on load: the server always rendered dark,
  and the client corrected it after hydration.

## Decision

1. **Three-way preference: `dark | light | system`.** When no preference is
   saved, the default is `dark`, because Offense Demo is dark-first. `system`
   follows `prefers-color-scheme`.
2. **Cookie, rendered by the server.** The preference is stored in the
   `offense-demo-theme` cookie: one year, `Path=/`, `SameSite=Lax`, and `Secure`
   over https. It is not httpOnly and it is not a secret. The root layout
   (already dynamic for the CSP nonce) reads the cookie through
   `parseThemePreference`, which is the trust boundary: unknown values fall
   back to `dark`. The layout renders `<html data-theme>` from the parsed
   value, so the served HTML is already correct. That removes the flash, the
   inline script, the nonce plumbing and the hydration mismatch.
3. **Tokens are written once with `light-dark()`.** Every color token in
   `globals.css` is `light-dark(<light>, <dark>)`, and `data-theme` only
   selects `color-scheme`: `dark`, `light`, or `light dark` for `system`.
   `system` therefore follows OS changes live with no JavaScript. The
   `globals-css.test.ts` guard fails if a color token covers only one scheme.
   `light-dark()` varies only colors, so the shadow offsets are shared by
   both themes. Light's `--shadow-2` moved from `0 4px 16px` to dark's
   `0 2px 12px`, and that is intentional.
4. **Request-scoped provider.** `ThemeProvider` (`src/ui/theme/`) is a React
   context seeded with the request's preference, so each request is kept
   apart by construction. A switch runs through `createThemeController`,
   whose side effects are injected: write the cookie, apply the theme inside
   a view transition (skipped under `prefers-reduced-motion`), then announce
   the change on a `BroadcastChannel`.
5. **Tabs converge on the cookie.** An announcement carries no value. A tab
   that receives one re-reads the shared cookie through the same trust
   boundary and applies it, so the last write wins and a delayed
   announcement can never apply a stale choice. A tab that missed an
   announcement, because it was frozen or restored from the back/forward
   cache, re-syncs from the cookie on `visibilitychange` and `pageshow`. A
   re-sync that finds nothing changed does nothing. If the browser blocks
   cookies, the switch applies to the current tab only, until reload. It is
   not announced, and a re-sync does not revert it.
6. **The provider renders the browser-chrome metas.** `ThemeProvider`
   renders `<meta name="color-scheme">` and one `theme-color` meta per OS
   scheme from its state; an explicit choice paints both with its own color.
   React 19 hoists them into `<head>` and keeps them in sync across soft and
   back/forward navigations. They are deliberately not Next viewport
   metadata: Next caches that per route and re-applies the pre-switch value
   on a Back navigation.
7. The only control today is the Dark/Light/System radio group on
   `/settings`.

## Consequences

- `theme-plugin.ts`, `theme-effect.tsx` and the store's `themeColor` are
  deleted. The module-level store keeps only static shell state.
- New color tokens must be written as `light-dark()` pairs.
- The photo scrims stay dark in both themes on purpose, because they sit
  over dark-graded photography. The `--scrim` token deliberately gives the
  same color for both schemes.
- When accounts arrive, a server-side saved preference can seed the same
  cookie. No other part of the mechanism changes.
