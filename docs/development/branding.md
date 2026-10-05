# Branding

Where the Offense Demo brand lives in `apps/web`, so a new project can make the
template its own in one pass. The token rules (how colours and type are
written and used) are [ADR 0028](../decisions/0028-tailwind-v4.md); the
light/dark mechanics are [ADR 0027](../decisions/0027-theme-preference.md).

## Where the pieces live

| Piece            | Location                                                                                                        | Notes                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette          | `apps/web/src/app/globals.css` (brand primitives and semantic `light-dark()` tokens), `apps/web/src/app/theme/` | The only place colour values are defined. Components use semantic tokens (`bg-surface`, `text-ink`, `bg-accent`), never primitives or hex values.                               |
| Static palette   | `apps/web/src/features/auth/brand-palette.ts`                                                                   | Plain-value copy of the tokens for surfaces rendered outside the Next CSS pipeline (emailed links, the confirm pages). `brand-palette.test.ts` keeps it equal to `globals.css`. |
| Mark             | `apps/web/src/ui/components/offense-demo-mark/`, geometry in `apps/web/src/ui/brand/`                           | The logo component and its variants. Keep every tunable number in one geometry module.                                                                                          |
| Fonts and images | `apps/web/public/fonts/`, `apps/web/public/images/`                                                             | Self-hosted (the strict CSP forbids third-party font and image hosts). Update the `@font-face` rules in `globals.css` when swapping fonts.                                      |
| Mail copy        | `apps/web/src/features/auth/mail/templates.ts` (subjects and bodies), `mail/layout.ts` (shell)                  | Product name, sign-in and notice wording. Subject lines must not leak account state. Rendered previews land in `mail/__fixtures__` for review.                                  |
| Product name     | `project.config.json` (`displayName`), page metadata in `apps/web/src/app/layout.tsx`                           | The init CLI replaces `Offense Demo` everywhere it appears; search for leftovers after renaming.                                                                                |

## Rules

- Change a colour only in `globals.css` (and its static copy), then check
  both schemes.
- Marks and brand graphics are decoration: `aria-hidden`, never the only
  carrier of meaning. Do not recolour a mark with ad-hoc classes, rotate or
  stretch it.
- Every text and UI pairing you add in markup (a new `text-*` on a new
  `bg-*`) is declared in `apps/web/src/app/palette-contrast.test.ts`, which
  holds each pair to WCAG AA in both schemes: 4.5:1 for text, 3:1 for UI.
- Visual baselines (`bun test:e2e`, see [testing](testing.md#visual-parity))
  change with the brand; regenerate them deliberately and review the diff.
