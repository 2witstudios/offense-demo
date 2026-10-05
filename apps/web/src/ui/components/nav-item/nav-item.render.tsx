import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icon/icon';
import { navCaretClass, navItemClass } from './nav-item-class';

export type NavItemChild = {
  readonly href: string;
  readonly label: string;
};

export type NavItemRenderProps = {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly active: boolean;
  /** Optional sub-navigation revealed on hover and keyboard focus. */
  readonly subItems?: readonly NavItemChild[] | undefined;
};

export function renderNavItem(props: NavItemRenderProps): ReactNode {
  const { href, icon, label, active, subItems } = props;
  const hasChildren = subItems !== undefined && subItems.length > 0;
  return (
    <span className="group relative block">
      <Link
        href={href}
        className={navItemClass(active)}
        aria-current={active ? 'page' : undefined}
      >
        <Icon name={icon} size={18} />
        <span className="flex-1 whitespace-nowrap max-compact:sr-only">
          {label}
        </span>
        {hasChildren ? (
          <span className={navCaretClass(active)} aria-hidden="true">
            <Icon name="chevronRight" size={14} />
          </span>
        ) : null}
      </Link>
      {hasChildren ? (
        <span className="invisible absolute top-0 left-full z-30 ml-2 flex min-w-flyout -translate-x-flyout-shift flex-col gap-1 rounded-md border border-border bg-surface-raised p-2 opacity-0 shadow-3 transition-all duration-120 ease-standard group-focus-within:visible group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:visible group-hover:translate-x-0 group-hover:opacity-100">
          {subItems.map((child) => (
            <Link
              key={child.href}
              href={child.href}
              className="block rounded-sm px-3 py-2 text-sm font-semibold whitespace-nowrap text-ink-muted no-underline hover:bg-surface-overlay hover:text-ink hover:no-underline"
            >
              {child.label}
            </Link>
          ))}
        </span>
      ) : null}
    </span>
  );
}
