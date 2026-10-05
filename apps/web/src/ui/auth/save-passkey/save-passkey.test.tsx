import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Button } from '../../components/button/button';
import { byText } from '../../test-support/find-elements';
import { SavePasskey, type SavePasskeyProps } from './save-passkey';
import { panelPageColours } from '../../test-support/stage-palette';

setupRitewayBun();

const props = (
  overrides: Partial<SavePasskeyProps> = {},
): SavePasskeyProps => ({
  username: 'jordan_l',
  pending: false,
  savePasskey: () => {},
  decline: () => {},
  ...overrides,
});

describe('SavePasskey', () => {
  test('offers save, shared, and not now', () => {
    const page = renderToString(h(SavePasskey, props()));
    assert({
      given: 'a freshly claimed username',
      should: 'confirm who is signed in and offer all three choices',
      actual: [
        page.includes('Signed in as <!-- -->jordan_l'),
        page.includes('Save a passkey on this device'),
        page.includes('This is a shared computer'),
        page.includes('Not now'),
        page.includes('disabled=""'),
      ],
      expected: [true, true, true, true, false],
    });
  });

  test('declining without a passkey is a real button in its own form, so it works without JavaScript', () => {
    const page = renderToString(h(SavePasskey, props()));
    assert({
      given: 'the shared-computer and not-now choices',
      should: 'be submit buttons inside their own forms, never links',
      actual: [
        page.match(/<form/g)?.length,
        page.match(/<button[^>]*type="submit"/g)?.length,
        page.includes('>This is a shared computer</a>'),
        page.includes('>Not now</a>'),
      ],
      expected: [2, 2, false, false],
    });
  });

  test('locks the choices while the device prompt is open', () => {
    const page = renderToString(h(SavePasskey, props({ pending: true })));
    assert({
      given: 'a pending save',
      should: 'say so and disable the save button and both decline buttons',
      actual: [
        page.includes('Waiting for your device…'),
        page.match(/disabled=""/g)?.length,
      ],
      expected: [true, 3],
    });
  });

  test('wires the save', () => {
    const calls: string[] = [];
    const tree = SavePasskey(props({ savePasskey: () => calls.push('save') }));
    (byText(tree, Button, 'Save a passkey')?.props['onClick'] as () => void)();
    assert({
      given: 'the save choice',
      should: 'call its action',
      actual: calls,
      expected: ['save'],
    });
  });

  test('draws its panel checks in the stage palette, not the page palette', () => {
    const page = renderToString(h(SavePasskey, props()));
    assert({
      given: 'the saved-facts list on the dark stage panel',
      should: 'use no page-palette colour, which is dark on dark in light',
      actual: panelPageColours(page),
      expected: [],
    });
  });
});
