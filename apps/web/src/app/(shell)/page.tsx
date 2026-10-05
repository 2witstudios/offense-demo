import Link from 'next/link';
import type { Metadata } from 'next';
import { appConfig } from '../../app-config';
import { requestIdentity } from '../../lib/request-session';
import { HomeJoin } from '../../ui/home/home-join';
import { homeSectionClass } from '../../ui/home/home-section-class';
import { requestLinkAction } from '../(bare)/sign-in/actions';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

/**
 * The public landing: the product's name and tagline, then the one-email
 * sign-in for a visitor (the sign-in page's own action, which works without
 * JavaScript and returns here to the signed-in home) or a way on for
 * someone already signed in.
 */
export default async function HomePage() {
  const identity = await requestIdentity();
  const signedIn =
    identity.state === 'member' || identity.state === 'provisional';
  const intro = (
    <>
      <h1 className="font-display text-3xl leading-tight font-semibold tracking-tighter text-balance">
        {appConfig.brand.displayName}
      </h1>
      <p className="text-lg text-ink-muted">{appConfig.brand.tagline}</p>
    </>
  );
  if (!signedIn)
    return (
      <HomeJoin requestLink={requestLinkAction.bind(null, appConfig.homeRoute)}>
        {intro}
      </HomeJoin>
    );
  return (
    <section className={homeSectionClass}>
      {intro}
      <Link href={appConfig.homeRoute} className="text-md font-semibold">
        Continue to the app
      </Link>
    </section>
  );
}
