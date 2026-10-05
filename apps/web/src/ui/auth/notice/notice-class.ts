export type NoticeTone = 'error' | 'info';

const boxes: Readonly<Record<NoticeTone, string>> = {
  error: 'flex items-start gap-3 rounded-md bg-live-soft px-4 py-3 text-base',
  info: 'flex items-start gap-3 rounded-md bg-surface-overlay px-4 py-3 text-base',
};

const icons: Readonly<Record<NoticeTone, string>> = {
  error: 'mt-1 text-live',
  info: 'mt-1 text-ink-muted',
};

/** Classes for a notice box of the given tone. */
export const noticeClass = (tone: NoticeTone): string => boxes[tone];

/** Classes for the icon that leads a notice of the given tone. */
export const noticeIconClass = (tone: NoticeTone): string => icons[tone];
