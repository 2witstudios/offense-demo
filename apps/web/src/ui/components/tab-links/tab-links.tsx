import Link from 'next/link';
import { tabLinkClass } from './tab-links-class';

type TabLink = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly selected: boolean;
  readonly count?: number;
};

export type TabLinksProps = {
  readonly label: string;
  readonly tabs: readonly TabLink[];
  readonly className?: string;
};

/** Tabs are links, so they work before hydration and keep the URL state. */
export function TabLinks({ label, tabs, className }: TabLinksProps) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="flex gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <li key={tab.id}>
            <Link
              href={tab.href}
              className={tabLinkClass(tab.selected)}
              aria-current={tab.selected ? 'page' : undefined}
            >
              {tab.label}
              {tab.count === undefined ? null : (
                <span className="font-book text-ink-faint">{tab.count}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
