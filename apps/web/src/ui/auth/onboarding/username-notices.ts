import type { NoticeCopy } from '../sign-in-notices';
import type { UsernameNotice } from './claim-form';

/** What each refused claim says: the problem, and the way out. */
export const usernameNotices: Readonly<Record<UsernameNotice, NoticeCopy>> = {
  invalid: {
    tone: 'error',
    title: 'That username will not work.',
    body: 'Use 3 to 32 letters, numbers, underscores or hyphens, with no spaces.',
  },
  taken: {
    tone: 'error',
    title: 'That username is already taken.',
    body: 'Try another one.',
  },
  'signed-out': {
    tone: 'error',
    title: 'Your sign-in ended.',
    body: 'Sign in again and we will pick up where you left off.',
  },
  'rate-limited': {
    tone: 'error',
    title: 'Too many attempts for now.',
    body: 'Wait a minute, then try again.',
  },
  unavailable: {
    tone: 'error',
    title: 'We could not save your username.',
    body: 'Nothing was changed. Please try again shortly.',
  },
};
