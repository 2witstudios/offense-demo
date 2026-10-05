import { renderToString } from 'react-dom/server';
import {
  Children,
  createElement as h,
  isValidElement,
  type ReactNode,
} from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { preferenceForKey, renderThemeSwitcher } from './theme-switcher.render';
import { ThemeSwitcher } from './theme-switcher';
import { ThemeProvider } from '../../theme/theme-provider';
import type { ThemePreference } from '../../theme/theme-preference';

setupRitewayBun();

type RadioProps = {
  readonly children?: ReactNode;
  readonly role?: string;
  readonly 'data-preference'?: string;
  readonly onClick?: () => void;
  readonly onKeyDown?: (event: unknown) => void;
};

const radiosOf = (node: ReactNode): readonly RadioProps[] => {
  if (!isValidElement<RadioProps>(node)) return [];
  if (node.props.role === 'radio') return [node.props];
  return Children.toArray(node.props.children).flatMap(radiosOf);
};

/** Parses each rendered radio's label, checked state, and tab stop. */
const radiosIn = (html: string) =>
  [
    ...html.matchAll(
      /<button([^>]*)>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/button>/g,
    ),
  ].map(([, attributes = '', label]) => ({
    label,
    checked: /aria-checked="true"/.test(attributes),
    tabIndex: /tabindex="(-?\d)"/i.exec(attributes)?.[1],
  }));

describe('renderThemeSwitcher', () => {
  test('renders a labelled radio group with the preference checked', () => {
    const html = renderToString(
      h(renderThemeSwitcher, {
        preference: 'light',
        selectPreference: () => {},
      }),
    );
    assert({
      given: 'the light preference',
      should: 'check Light, keep one tab stop, and name the group',
      actual: {
        group: html.includes('role="radiogroup" aria-label="Theme"'),
        radios: radiosIn(html),
      },
      expected: {
        group: true,
        radios: [
          { label: 'Dark', checked: false, tabIndex: '-1' },
          { label: 'Light', checked: true, tabIndex: '0' },
          { label: 'System', checked: false, tabIndex: '-1' },
        ],
      },
    });
  });

  test('selects the clicked preference', () => {
    const chosen: ThemePreference[] = [];
    const radios = radiosOf(
      renderThemeSwitcher({
        preference: 'dark',
        selectPreference: (preference) => chosen.push(preference),
      }),
    );
    for (const radio of radios) radio.onClick?.();
    assert({
      given: 'a click on each radio',
      should: 'select each preference in order',
      actual: chosen,
      expected: ['dark', 'light', 'system'],
    });
  });

  test('moves selection and focus with arrow keys', () => {
    const chosen: ThemePreference[] = [];
    const focused: string[] = [];
    let prevented = 0;
    const [dark] = radiosOf(
      renderThemeSwitcher({
        preference: 'dark',
        selectPreference: (preference) => chosen.push(preference),
      }),
    );
    const press = (key: string) =>
      dark?.onKeyDown?.({
        key,
        preventDefault: () => {
          prevented += 1;
        },
        currentTarget: {
          parentElement: {
            querySelector: (selector: string) => ({
              focus: () => focused.push(selector),
            }),
          },
        },
      });
    press('ArrowRight');
    press('Tab');
    assert({
      given: 'ArrowRight then Tab on the checked Dark radio',
      should: 'select and focus Light, and leave Tab to the browser',
      actual: { chosen, focused, prevented },
      expected: {
        chosen: ['light'],
        focused: ['[data-preference="light"]'],
        prevented: 1,
      },
    });
  });
});

describe('preferenceForKey', () => {
  test('steps through the options and wraps at both ends', () => {
    assert({
      given: 'arrow keys from each end and a non-arrow key',
      should: 'step with wrap-around and ignore other keys',
      actual: [
        preferenceForKey('dark', 'ArrowLeft'),
        preferenceForKey('system', 'ArrowDown'),
        preferenceForKey('dark', 'ArrowUp'),
        preferenceForKey('light', 'ArrowRight'),
        preferenceForKey('light', 'Enter'),
      ],
      expected: ['system', 'dark', 'system', 'system', undefined],
    });
  });
});

describe('ThemeSwitcher', () => {
  test('reflects the provider preference', () => {
    const html = renderToString(
      h(ThemeProvider, {
        initialPreference: 'system',
        children: h(ThemeSwitcher),
      }),
    );
    assert({
      given: 'a provider seeded with system',
      should: 'render System as the checked radio',
      actual: radiosIn(html)
        .filter((radio) => radio.checked)
        .map((radio) => radio.label),
      expected: ['System'],
    });
  });
});
