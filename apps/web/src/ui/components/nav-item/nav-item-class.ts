import { cn } from '../../cn';

const navItemBase =
  'flex items-center gap-3 rounded-md px-4 py-3 text-md font-semibold no-underline transition-colors duration-120 ease-standard hover:no-underline max-compact:justify-center max-compact:px-0';

/** Classes for the primary link; each state owns its colors. */
export const navItemClass = (active: boolean): string =>
  cn(
    navItemBase,
    active
      ? 'bg-accent-soft text-accent-strong hover:bg-accent-soft hover:text-accent-strong'
      : 'text-ink-muted hover:bg-surface hover:text-ink',
  );

/** Classes for the flyout caret; it shows while the wrapper is hovered or focused. */
export const navCaretClass = (active: boolean): string =>
  cn(
    'inline-flex opacity-0 transition-opacity duration-120 ease-standard group-focus-within:opacity-100 group-hover:opacity-100 max-compact:hidden',
    active ? 'text-accent-strong' : 'text-ink-faint',
  );
