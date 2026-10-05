import type { KeyboardEvent, ReactNode } from 'react';
import { Icon } from '../icon/icon';
import type { ThemePreference } from '../../theme/theme-preference';
import { optionClass, switcherClass } from './theme-switcher-class';

const options = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'system', label: 'System', icon: 'monitor' },
] as const satisfies readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly icon: string;
}[];

const steps: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Radio-group arrow keys: move and select, wrapping at either end. */
export const preferenceForKey = (
  current: ThemePreference,
  key: string,
): ThemePreference | undefined => {
  const step = steps[key];
  if (step === undefined) return undefined;
  const index = options.findIndex((option) => option.value === current);
  return options[(index + step + options.length) % options.length]?.value;
};

export type ThemeSwitcherRenderProps = {
  readonly preference: ThemePreference;
  /** Void action: persists and applies the chosen preference. */
  readonly selectPreference: (preference: ThemePreference) => void;
};

export function renderThemeSwitcher({
  preference,
  selectPreference,
}: ThemeSwitcherRenderProps): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = preferenceForKey(preference, event.key);
    if (next === undefined) return;
    event.preventDefault();
    selectPreference(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLElement>(`[data-preference="${next}"]`)
      ?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Theme" className={switcherClass}>
      {options.map(({ value, label, icon }) => {
        const checked = value === preference;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-preference={value}
            className={optionClass(checked)}
            onClick={() => selectPreference(value)}
            onKeyDown={onKeyDown}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
