import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Button } from '../../components/button/button';
import { byText } from '../../test-support/find-elements';
import { panelPageColours } from '../../test-support/stage-palette';
import { CheckInbox, type CheckInboxProps } from './check-inbox';

setupRitewayBun();

const props = (overrides: Partial<CheckInboxProps> = {}): CheckInboxProps => ({
  email: 'jordan@lincoln.edu',
  resendInMs: 42_000,
  resending: false,
  resend: () => {},
  changeEmail: () => {},
  ...overrides,
});

const html = (overrides: Partial<CheckInboxProps> = {}) =>
  renderToString(h(CheckInbox, props(overrides)));

describe('CheckInbox', () => {
  test('never confirms that an account exists', () => {
    const page = html();
    assert({
      given: 'a sent link',
      should: 'hedge on delivery, name the limits, and show the next steps',
      actual: [
        page.includes('If <strong'),
        page.includes('can<!-- --> receive email') ||
          page.includes('can receive email'),
        page.includes('expires') && page.includes('5 minutes'),
        page.includes('<ol'),
      ],
      expected: [true, true, true, true],
    });
  });

  test('counts down to the resend', () => {
    const page = html();
    assert({
      given: '42 seconds left',
      should: 'show the countdown on a disabled resend button',
      actual: [page.includes('Resend in 0:42'), page.includes('disabled=""')],
      expected: [true, true],
    });
  });

  test('offers the resend once the cooldown ends', () => {
    const page = html({ resendInMs: 0 });
    assert({
      given: 'no time left',
      should: 'enable the resend',
      actual: [page.includes('Resend link'), page.includes('disabled=""')],
      expected: [true, false],
    });
  });

  test('wires the actions', () => {
    const calls: string[] = [];
    const tree = CheckInbox(
      props({
        resendInMs: 0,
        resend: () => calls.push('resend'),
        changeEmail: () => calls.push('change'),
      }),
    );
    (byText(tree, Button, 'Resend link')?.props['onClick'] as () => void)();
    (
      byText(tree, Button, 'Use a different email')?.props[
        'onClick'
      ] as () => void
    )();
    assert({
      given: 'a resend and a change of address',
      should: 'call both actions',
      actual: calls,
      expected: ['resend', 'change'],
    });
  });

  test('draws its panel steps in the stage ink, not the page palette', () => {
    const page = html();
    assert({
      given: 'the numbered steps on the dark stage panel',
      should: 'use no page-palette colour, which is dark on dark in light',
      actual: panelPageColours(page),
      expected: [],
    });
  });
});
