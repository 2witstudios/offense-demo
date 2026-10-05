export type StatusTone = 'online' | 'live' | 'neutral';

export const statusLineClass =
  'inline-flex items-center gap-2 text-sm whitespace-nowrap text-ink-muted';

const base = 'size-2 rounded-round';

const dots: Readonly<Record<StatusTone, string>> = {
  online: 'bg-online',
  live: 'bg-live',
  neutral: 'bg-ink-faint',
};

/** Classes for the status dot of the given tone. */
export const statusDotClass = (tone: StatusTone): string =>
  `${base} ${dots[tone]}`;
