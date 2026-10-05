// Shared sign-in state fixtures for the reducer and guard tests.
import type { SignInState } from './sign-in-state';

/** Epoch ms as the UTC ISO string the clock hands out. */
export const iso = (ms: number): string => new Date(ms).toISOString();

export const entering = (
  overrides: Partial<Extract<SignInState, { step: 'enter-email' }>> = {},
): SignInState => ({
  step: 'enter-email',
  email: 'jordan@lincoln.edu',
  pending: 'none',
  ...overrides,
});

export const inbox = (
  overrides: Partial<Extract<SignInState, { step: 'check-inbox' }>> = {},
): SignInState => ({
  step: 'check-inbox',
  email: 'jordan@lincoln.edu',
  sentAt: iso(1_000),
  resending: false,
  ...overrides,
});
