import Link from 'next/link';
import { Avatar } from '../../../../components/avatar/avatar';
import { BrandWordmark } from '../../../../components/brand-mark/brand-mark';
import { appConfig } from '../../../../../app-config';

/** Who the shell is showing: derived on the server from the durable session. */
export type ShellAccount =
  | { readonly state: 'anonymous' }
  | { readonly state: 'provisional' }
  | { readonly state: 'member'; readonly username: string };

const accountLink =
  'flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-bold whitespace-nowrap text-ink no-underline hover:bg-surface-overlay hover:no-underline';

function AccountControl({ account }: { readonly account: ShellAccount }) {
  switch (account.state) {
    case 'anonymous':
      return (
        <Link href="/sign-in" className={accountLink}>
          Sign in
        </Link>
      );
    case 'provisional':
      return (
        <Link href="/onboarding/username" className={accountLink}>
          Finish sign-up
        </Link>
      );
    case 'member':
      return (
        <Link
          href="/settings"
          className={accountLink}
          aria-label={`Account settings for ${account.username}`}
        >
          <Avatar name={account.username} size="md" />
          <span className="max-compact:hidden">{account.username}</span>
        </Link>
      );
  }
}

export function Topbar({ account }: { readonly account: ShellAccount }) {
  return (
    <header className="flex h-topbar items-center gap-6 px-6 max-compact:gap-4 max-compact:px-4">
      <Link
        href="/"
        aria-label={`${appConfig.brand.displayName} home`}
        className="flex items-center gap-2 text-ink no-underline hover:no-underline"
      >
        <BrandWordmark nameClassName="max-narrow:hidden" />
      </Link>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-4">
        <AccountControl account={account} />
      </div>
    </header>
  );
}
