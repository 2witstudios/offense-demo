import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { Button } from '../../components/button/button';
import { byText, findElements } from '../../test-support/find-elements';
import { SignInForm, type SignInFormProps } from './sign-in-form';

setupRitewayBun();

const props = (overrides: Partial<SignInFormProps> = {}): SignInFormProps => ({
  email: '',
  pending: 'none',
  typeEmail: () => {},
  action: () => {},
  requestLink: () => true,
  signInWithPasskey: () => {},
  ...overrides,
});

/** Submits the form's element, recording a prevented default in `calls`. */
const submit = (tree: ReturnType<typeof SignInForm>, calls: string[]) => {
  const form = findElements(tree, (element) => element.type === 'form')[0];
  (form?.props['onSubmit'] as (event: object) => void)({
    preventDefault: () => calls.push('prevented'),
  });
  return form;
};

const html = (overrides: Partial<SignInFormProps> = {}) =>
  renderToString(h(SignInForm, props(overrides)));

describe('SignInForm', () => {
  test('offers one email field and a passkey button', () => {
    const page = html();
    assert({
      given: 'an idle form',
      should:
        'label the email field, let the browser offer a passkey, and show both actions',
      actual: [
        page.includes('<label for="sign-in-email"'),
        page.includes('autoComplete="username webauthn"') ||
          page.includes('autocomplete="username webauthn"'),
        page.includes('type="email"'),
        page.includes('Continue'),
        page.includes('Sign in with a passkey'),
        page.includes('<h1'),
      ],
      expected: [true, true, true, true, true, true],
    });
  });

  test('sends new people to email, not the saved-passkey prompt', () => {
    const page = html();
    assert({
      given: 'an idle form',
      should:
        'make email the path for everyone and tie a saved-passkeys-only hint to the passkey button',
      actual: [
        page.includes('Enter your email and we&#x27;ll send you a link.'),
        page.includes('aria-describedby="sign-in-passkey-hint"'),
        page.includes('id="sign-in-passkey-hint"'),
        page.includes('For returning users.'),
        page.includes('New here? Use your email.'),
      ],
      expected: [true, true, true, true, true],
    });
  });

  test('disables both paths while a link is sending', () => {
    const page = html({ email: 'j@school.edu', pending: 'link' });
    assert({
      given: 'a pending link request',
      should: 'show progress, announce it, and disable every control',
      actual: [
        page.includes('Sending…'),
        page.includes('Sending your sign-in link…'),
        page.includes('aria-busy="true"'),
        page.match(/disabled=""/g)?.length,
      ],
      expected: [true, true, true, 3],
    });
  });

  test('announces a waiting passkey ceremony', () => {
    const page = html({ pending: 'passkey' });
    assert({
      given: 'a pending passkey ceremony',
      should: 'tell the person to follow the browser prompt',
      actual: [
        page.includes('Waiting for your passkey…'),
        page.includes('Follow your browser&#x27;s prompt'),
      ],
      expected: [true, true],
    });
  });

  test('ties an undeliverable address to the field as an alert', () => {
    const page = html({ email: 'j@school.edu', notice: 'undeliverable' });
    assert({
      given: 'an undeliverable notice',
      should: 'raise an alert the input points at',
      actual: [
        page.includes('role="alert"'),
        page.includes('aria-invalid="true"'),
        page.includes('aria-describedby="sign-in-notice"'),
        page.includes('We cannot send sign-in emails to this address.'),
      ],
      expected: [true, true, true, true],
    });
  });

  test('reports a cancelled passkey quietly, without blaming the address', () => {
    const page = html({ notice: 'passkey-cancelled' });
    assert({
      given: 'a cancelled passkey ceremony, which may mean no passkey is saved',
      should:
        'point a new person to email in a status, not an alert, and leave the input valid',
      actual: [
        page.includes('No passkey used.'),
        page.includes('New here? Continue with your email.'),
        page.includes('role="alert"'),
        page.includes('aria-invalid="true"'),
      ],
      expected: [true, true, false, false],
    });
  });

  test('wires the actions', () => {
    const calls: string[] = [];
    const action = () => {};
    const tree = SignInForm(
      props({
        typeEmail: (email) => calls.push(`type:${email}`),
        action,
        requestLink: () => {
          calls.push('link');
          return true;
        },
        signInWithPasskey: () => calls.push('passkey'),
      }),
    );
    const form = submit(tree, calls);
    (
      byText(tree, Button, 'Sign in with a passkey')?.props[
        'onClick'
      ] as () => void
    )();
    const field = findElements(
      tree,
      (element) => element.props['typeEmail'] !== undefined,
    )[0];
    (field?.props['typeEmail'] as (email: string) => void)('j@school.edu');
    assert({
      given: 'a submit, a passkey click, and typing',
      should:
        'post the form to its action, marking the request, and call the matching actions',
      actual: [form?.props['action'] === action, calls],
      expected: [true, ['link', 'passkey', 'type:j@school.edu']],
    });
  });

  test('keeps a request that must not post from posting', () => {
    const calls: string[] = [];
    submit(SignInForm(props({ requestLink: () => false })), calls);
    assert({
      given: 'a submit the flow refuses (an empty address, or one in flight)',
      should: 'stop the post',
      actual: calls,
      expected: ['prevented'],
    });
  });

  test('renders a form the browser can post without JavaScript', () => {
    const page = html();
    assert({
      given: 'the server render',
      should: 'post the address as the email field, and never by GET',
      actual: [
        page.includes('name="email"'),
        /<form[^>]*method="get"/i.test(page),
      ],
      expected: [true, false],
    });
  });
});
