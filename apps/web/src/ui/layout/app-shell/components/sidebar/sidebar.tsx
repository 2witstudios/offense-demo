import { appConfig } from '../../../../../app-config';
import { NavItem } from '../../../../components/nav-item/nav-item';

/** The sidebar's links: the primary navigation from `appConfig`. */
export function Sidebar() {
  return (
    <nav
      aria-label="Primary"
      className="flex h-full flex-col justify-between py-4"
    >
      <ul className="flex list-none flex-col gap-1 p-4 max-compact:px-2 max-compact:py-0">
        {appConfig.navigation.map((item) => (
          <li key={item.href}>
            <NavItem href={item.href} icon={item.icon} label={item.label} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
