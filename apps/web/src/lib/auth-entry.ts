import { redirect } from 'next/navigation';
import type { Identity } from '@offense-demo/auth';
import { createAppError } from '@offense-demo/errors';
import {
  nextDestination,
  signInHref,
  type SearchParams,
} from '../features/access/decision';
import { requestIdentity } from './request-session';

/**
 * What the sign-in and onboarding pages start from: the validated `?next=`
 * destination (untrusted input; only a local path survives) and who is
 * asking, resolved from this request's durable session.
 */
export async function readAuthEntry(
  searchParams: Promise<SearchParams>,
): Promise<{ readonly destination: string; readonly identity: Identity }> {
  return {
    destination: nextDestination(await searchParams),
    identity: await requestIdentity(),
  };
}

type SignedIn = Extract<Identity, { state: 'provisional' | 'member' }>;

/**
 * An onboarding page's entry: the validated destination and a signed-in
 * account. A session-store outage is a retryable error, not "signed out";
 * an anonymous visitor signs in first and comes back to `here`.
 */
export async function readOnboardingEntry(
  searchParams: Promise<SearchParams>,
  here: (destination: string) => string,
): Promise<{ readonly destination: string; readonly identity: SignedIn }> {
  const { destination, identity } = await readAuthEntry(searchParams);
  if (identity.state === 'unavailable') throw createAppError('INFRASTRUCTURE');
  if (identity.state === 'anonymous') redirect(signInHref(here(destination)));
  return { destination, identity };
}
