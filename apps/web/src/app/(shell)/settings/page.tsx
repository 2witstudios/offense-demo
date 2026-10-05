import Link from 'next/link';
import type { Metadata } from 'next';
import type { SearchParams } from '../../../features/access/decision';
import { requireAccess } from '../../../lib/access';
import { RouteShell } from '../../ui/route-shell';
import { ThemeSwitcher } from '../../../ui/components/theme-switcher/theme-switcher';
import { prose } from '../../ui/prose-class';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAccess('/settings', searchParams);
  return (
    <>
      <RouteShell
        title="Settings"
        lede="Account and notification preferences."
        planned={[
          'Profile and account management',
          'Notification and privacy controls',
          'Session and device management',
        ]}
      />
      <section aria-labelledby="appearance-heading">
        <h2 className={prose.h2} id="appearance-heading">
          Appearance
        </h2>
        <p className={prose.p}>
          Choose a theme, or follow your device setting.
        </p>
        <ThemeSwitcher />
      </section>
      <section aria-labelledby="security-heading">
        <h2 className={prose.h2} id="security-heading">
          Security
        </h2>
        <p className={prose.p}>
          Manage your passkeys, sessions and recovery email.
        </p>
        <Link href="/settings/security">Account security</Link>
      </section>
    </>
  );
}
