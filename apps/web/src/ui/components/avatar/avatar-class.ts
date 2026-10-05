export type AvatarSize = 'sm' | 'md' | 'lg';

const base =
  'relative inline-flex shrink-0 items-center justify-center rounded-round border border-border bg-surface-overlay font-bold text-ink-muted';

const sizes: Readonly<Record<AvatarSize, string>> = {
  sm: 'size-avatar-sm text-xs',
  md: 'size-avatar-md text-sm',
  lg: 'size-avatar-lg text-md',
};

/** Classes for an avatar of the given size. */
export const avatarClass = (size: AvatarSize): string =>
  `${base} ${sizes[size]}`;
