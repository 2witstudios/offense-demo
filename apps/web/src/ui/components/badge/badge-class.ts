export type BadgeTone = 'neutral' | 'live' | 'gold' | 'accent';

const base =
  'inline-flex items-center gap-1 rounded-badge px-badge-x py-badge-y text-badge leading-tight font-heavy tracking-wider whitespace-nowrap uppercase';

const tones: Readonly<Record<BadgeTone, string>> = {
  neutral: 'bg-surface-overlay text-ink-muted',
  live: 'bg-live-soft text-live',
  gold: 'bg-transparent text-gold',
  accent: 'bg-accent-soft text-accent',
};

/** Classes for a badge of the given tone. */
export const badgeClass = (tone: BadgeTone): string => `${base} ${tones[tone]}`;
