'use client';

import { usePathname } from 'next/navigation';
import { renderNavItem } from './nav-item.render';
import type { IconName } from '../icon/icon';
import type { NavItemChild } from './nav-item.render';

export type NavItemProps = {
  readonly href: string;
  readonly icon: IconName;
  readonly label: string;
  readonly subItems?: readonly NavItemChild[] | undefined;
};

/** Exact for `/`; otherwise also active for that route's own descendants. */
export const matchesRoute = (
  pathname: string | null,
  href: string,
): boolean => {
  if (pathname === null) return false;
  return href === '/'
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
};

export function NavItem({ href, icon, label, subItems }: NavItemProps) {
  // The URL is the single source of truth for the active route, so
  // deep links and back/forward mark the right item, including on a
  // descendant of this item's own route or of one of its sub-items.
  const pathname = usePathname();
  const active =
    matchesRoute(pathname, href) ||
    (subItems ?? []).some((child) => matchesRoute(pathname, child.href));
  return renderNavItem({
    href,
    icon,
    label,
    active,
    subItems,
  });
}
