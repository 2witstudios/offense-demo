import Link from 'next/link';
import type { Metadata } from 'next';
import type { SearchParams } from '../../../features/access/decision';
import { requireAccess } from '../../../lib/access';
import { prose } from '../../ui/prose-class';

export const metadata: Metadata = { title: 'App' };

/**
 * The sample guarded page and the signed-in home (`appConfig.homeRoute`):
 * `/app` is a participant area, so `requireAccess` sends a visitor to
 * sign-in and an account without a username to onboarding before this
 * renders. Replace it with the product's first real screen.
 */
export default async function AppHomePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const identity = await requireAccess('/app', searchParams);
  const username = identity.state === 'member' ? identity.username : null;
  return (
    <section className="p-10 max-narrow:p-6">
      <h1 className={prose.h1}>
        {username === null
          ? 'You’re signed in'
          : `You’re signed in as ${username}`}
      </h1>
      <p className={prose.p}>
        This page is only reachable with an account. Build the product here.
      </p>
      <p className={prose.p}>
        <Link href="/settings">Settings</Link>
      </p>
    </section>
  );
}
