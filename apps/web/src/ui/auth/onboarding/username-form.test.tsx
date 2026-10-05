import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { findElements } from '../../test-support/find-elements';
import { UsernameForm, type UsernameFormProps } from './username-form';

setupRitewayBun();

const props = (
  overrides: Partial<UsernameFormProps> = {},
): UsernameFormProps => ({
  username: 'ada',
  pending: false,
  action: () => {},
  check: () => true,
  edited: () => {},
  signInHref: '/sign-in?next=%2Fonboarding%2Fusername',
  ...overrides,
});
const render = (overrides: Partial<UsernameFormProps> = {}) =>
  renderToString(h(UsernameForm, props(overrides)));

/** A stand-in for the submit event React hands the form. */
const submitted = (username: string) => {
  let prevented = false;
  return {
    event: {
      currentTarget: {
        elements: { namedItem: (name: string) => ({ name, value: username }) },
      },
      preventDefault: () => {
        prevented = true;
      },
    },
    prevented: () => prevented,
  };
};

describe('UsernameForm', () => {
  test('labels the field and states the rule', () => {
    const page = render();
    assert({
      given: 'the choose step',
      should: 'label the input and describe it with the rule',
      actual: [
        page.includes('<label for="username"'),
        page.includes('aria-describedby="username-hint"'),
        page.includes('3 to 32 letters, numbers, underscores or hyphens.'),
      ],
      expected: [true, true, true],
    });
  });

  test('keeps what was typed', () => {
    const page = render({ username: 'Ada Lovelace' });
    assert({
      given: 'a name returned with a refusal',
      should: 'post the field by name and start it from that name',
      actual: [
        page.includes('name="username"'),
        page.includes('value="Ada Lovelace"'),
      ],
      expected: [true, true],
    });
  });

  test('marks a refused name invalid and ties it to the notice', () => {
    const page = render({ notice: 'taken' });
    assert({
      given: 'a taken name',
      should: 'flag the input and describe it by the hint and the alert',
      actual: [
        page.includes('aria-invalid="true"'),
        page.includes('aria-describedby="username-hint username-notice"'),
        page.includes('role="alert"'),
      ],
      expected: [true, true, true],
    });
  });

  test('offers a way back when the session ended', () => {
    assert({
      given: 'the signed-out notice, and then another notice',
      should: 'link to sign-in only for the signed-out case',
      actual: [
        render({ notice: 'signed-out' }).includes(
          'href="/sign-in?next=%2Fonboarding%2Fusername"',
        ),
        render({ notice: 'taken' }).includes('Sign in again</a>'),
      ],
      expected: [true, false],
    });
  });

  test('stops a submission the local check refuses', () => {
    const [form] = findElements(
      UsernameForm(props({ check: (name) => name !== 'a b' })),
      (element) => element.type === 'form',
    );
    const onSubmit = form?.props['onSubmit'] as (event: unknown) => void;
    const refused = submitted('a b');
    onSubmit(refused.event);
    const accepted = submitted('ada');
    onSubmit(accepted.event);
    assert({
      given: 'a name the check refuses, then one it accepts',
      should: 'prevent only the refused submission',
      actual: [refused.prevented(), accepted.prevented()],
      expected: [true, false],
    });
  });
});
