import type { NoticeTone } from './notice/notice-class';
import type { SignInNotice } from './sign-in-state';

export type NoticeCopy = {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly body: string;
};

/**
 * What each refused request says. Errors name the problem and the way out;
 * a cancelled or unsupported passkey is information, not a failure, because
 * the email path is still right there.
 */
export const signInNotices: Readonly<Record<SignInNotice, NoticeCopy>> = {
  undeliverable: {
    tone: 'error',
    title: 'We cannot send sign-in emails to this address.',
    body: 'Sign in with a passkey or use a different address.',
  },
  // A 429 can come from a shared network's limit (AUTH-3.10), not the
  // person's own requests, so it names the wait and the other way in.
  'rate-limited': {
    tone: 'error',
    title: 'Too many sign-in requests right now.',
    body: 'Wait a minute, then try again, or sign in with a passkey. Links you already asked for still work.',
  },
  unavailable: {
    tone: 'error',
    title: 'Sign-in is temporarily unavailable.',
    body: 'Please try again shortly.',
  },
  'passkey-cancelled': {
    tone: 'info',
    title: 'No passkey used.',
    body: 'New here? Continue with your email.',
  },
  'passkey-unsupported': {
    tone: 'info',
    title: 'This browser cannot use passkeys.',
    body: 'Continue with your email instead.',
  },
  'passkey-failed': {
    tone: 'error',
    title: 'We could not sign you in with a passkey.',
    body: 'Try again, or continue with your email.',
  },
};
