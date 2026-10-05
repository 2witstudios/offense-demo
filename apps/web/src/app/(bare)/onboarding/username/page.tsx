import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readOnboardingEntry } from '../../../../lib/auth-entry';
import {
  onboardingHref,
  signInHref,
  type SearchParams,
} from '../../../../features/access/decision';
import { Onboarding } from '../../../../ui/auth/onboarding/onboarding';
import { claimUsernameAction } from './actions';

export const metadata: Metadata = {
  title: 'Choose a username',
  robots: { index: false, follow: false },
};

/**
 * Username onboarding. Anonymous visitors sign in first and return here; a
 * finished account goes straight on. Signing in again after an interrupted
 * signup lands here too, because the participant guard sends provisional
 * accounts to this page.
 */
export default async function OnboardingUsernamePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { destination, identity } = await readOnboardingEntry(
    searchParams,
    onboardingHref,
  );
  if (identity.state === 'member') redirect(destination);
  return (
    <Onboarding
      claim={claimUsernameAction.bind(null, destination)}
      signInHref={signInHref(onboardingHref(destination))}
    />
  );
}
