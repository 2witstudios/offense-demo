import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readOnboardingEntry } from '../../../../lib/auth-entry';
import {
  onboardingHref,
  passkeyOfferHref,
  type SearchParams,
} from '../../../../features/access/decision';
import { PasskeyOffer } from '../../../../ui/auth/onboarding/passkey-offer';
import { declinePasskeyAction } from './actions';

export const metadata: Metadata = {
  title: 'Save a passkey',
  robots: { index: false, follow: false },
};

/**
 * The passkey offer that follows a claimed username. The claim moves on to
 * here, with or without JavaScript. An account still choosing a name goes
 * back to that step; anonymous visitors sign in first.
 */
export default async function OnboardingPasskeyPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { destination, identity } = await readOnboardingEntry(
    searchParams,
    passkeyOfferHref,
  );
  if (identity.state === 'provisional') redirect(onboardingHref(destination));
  return (
    <PasskeyOffer
      username={identity.username}
      destination={destination}
      decline={declinePasskeyAction.bind(null, destination)}
    />
  );
}
