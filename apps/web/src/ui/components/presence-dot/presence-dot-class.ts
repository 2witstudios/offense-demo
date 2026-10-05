import type { PresenceStatus as Presence } from '@offense-demo/protocol';

const base =
  'inline-block size-presence-dot rounded-round border-2 border-surface';

const fills: Readonly<Record<Presence, string>> = {
  online: 'bg-online',
  'in-room': 'bg-live',
  away: 'bg-gold',
  offline: 'bg-ink-faint',
};

/** Classes for a presence dot of the given presence. */
export const presenceDotClass = (presence: Presence): string =>
  `${base} ${fills[presence]}`;
