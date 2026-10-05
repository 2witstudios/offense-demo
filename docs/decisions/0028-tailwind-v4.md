# 0028: Tailwind CSS v4, token-locked

Status: accepted (owner decision, 2026-09-21). Supersedes the "no CSS
framework yet" stance in `docs/dependencies.md` and the Dashboard shell
epic's "deliberately no shadcn and no Tailwind" scope line. Builds on
[ADR 0027](0027-theme-preference.md) (theme tokens) and the strict nonce CSP
in `apps/web/src/proxy.ts`.

The palette the tokens carry, and the brand built on them, are described in
[branding](../development/branding.md). This record stays the authority for
how tokens are written and used.

## Context

The component library was vanilla CSS Modules over design tokens: 25
`*.module.css` files, about 1,600 lines. The owner writes utilities inline
and wants that idiom, with safeguards that stop AI and human edits from
drifting off the token system. CSS Modules also had three maintenance
costs:

- Styles are separate from markup, so deleting markup leaves dead classes
  that no gate catches.
- A shared class is an action at a distance: an edit can restyle elements
  the author never looked at.
- Module classes resolve to `undefined` under `bun test`, so markup tests
  cannot see styling. Two tests read the stylesheet text to work around it.

## Decision

1. **Tailwind CSS v4, configured only in CSS.** `globals.css` holds
   `@import "tailwindcss"`, the Offense Demo tokens, `@theme` and `@theme inline`
   blocks, `@custom-variant`, and `@utility`. `apps/web/postcss.config.mjs`
   contains only `@tailwindcss/postcss`. There is no `tailwind.config.*`
   anywhere; a repository gate fails if one is added.
2. **Offense Demo tokens are the only design system.** `@theme` resets every default
   namespace (`--color-*`, `--spacing-*` and the `--spacing` multiplier,
   `--radius-*`, `--text-*`, `--font-*`, `--shadow-*`, `--breakpoint-*`,
   `--container-*`, `--ease-*`, `--animate-*`, `--blur-*`, `--inset-shadow-*`,
   `--drop-shadow-*`, `--text-shadow-*`, `--perspective-*`, `--aspect-*`) with
   `initial`, then maps only Offense Demo tokens. Verified against 4.3.3: after the
   reset `bg-red-500`, `p-7`, `text-lg`, `rounded-md`, `shadow-md`, `sm:` and
   `font-sans` generate no CSS.
3. **Tokens stay `light-dark()` custom properties on `:root`.**
   `@theme inline` maps them (`--color-surface: var(--surface)`), so
   utilities emit `var(--surface)` and a theme switch (`<html data-theme>`,
   ADR 0027) restyles the page with no class change. `dark:` and every other
   color-scheme variant are banned in markup; per-element dual colors cannot
   sit beside the tokens.
4. **Breakpoints are named tokens used through `max-*` variants.** The
   existing CSS is desktop-first. The widths are `--breakpoint-*` tokens and
   used as `max-<name>:`; the one height query is an `@custom-variant`.
5. **Safeguards, all in `bun check`.**
   - `eslint-plugin-better-tailwindcss` (`no-unknown-classes`,
     `no-conflicting-classes`, `no-duplicate-classes`,
     `no-restricted-classes` for arbitrary values/properties and `dark:`),
     pointed at `globals.css` as its entry point. It checks markup and the
     variant class modules (`*-class.ts`), where every string and object
     value is a class list whatever its variable name.
   - `prettier-plugin-tailwindcss` sorts classes; `format:check` fails on an
     unsorted list.
   - `scripts/check-styling.ts` fails on any `*.module.css` or
     `tailwind.config.*`, or an inline `style` attribute or `<style>` element
     in app markup.
   - Every rule has a negative fixture proving it fires.
6. **Class composition is a local pure join, not a library.** `cn` in
   `apps/web/src/ui/cn.ts` joins truthy strings. Variant props are pure
   functions from props to a literal class string. `tailwind-merge` and
   `cva` are not adopted: conflicting and duplicate classes are lint errors
   rather than runtime merges, so a merger would only hide them, and the
   variant functions are already plain maps. `cn` is the single approach;
   ad-hoc `filter(Boolean).join` and template-literal joins are removed.
7. **Build-time stylesheet only.** Tailwind emits a static stylesheet through
   the PostCSS build. No inline `style` attributes and no runtime style
   injection, so the nonce `style-src` and hash-only `style-src-attr` in
   `proxy.ts` are unchanged.
8. **Parity is proven with screenshots.** Playwright screenshot baselines
   (dashboard and settings, dark and light, desktop and mobile) were captured
   on unmodified `main` before any conversion, in the Linux Playwright image
   matching `@playwright/test`, and must match after.

## Consequences

- Utilities live on the element and are readable. `@utility` is reserved for
  patterns with no token-locked utility equivalent (named grid areas); it
  never hides a long class list.
- `bun check` fails on drift instead of relying on review.
- Removal path: replace the utilities with a stylesheet per component and
  delete the plugin, gate, and dependency rows. There is no compatibility
  mode; this is a greenfield replacement (ADR 0023).
