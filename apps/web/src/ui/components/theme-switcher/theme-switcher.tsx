'use client';

import { useThemePreference } from '../../theme/theme-provider';
import { renderThemeSwitcher } from './theme-switcher.render';

/** Dark / Light / System control bound to the request's theme provider. */
export function ThemeSwitcher() {
  return renderThemeSwitcher(useThemePreference());
}
