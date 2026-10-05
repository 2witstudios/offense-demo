import { renderToString } from 'react-dom/server';
import { isValidElement, type ReactElement } from 'react';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { CheckInbox } from '../check-inbox/check-inbox';
import { SignInForm } from '../sign-in-form/sign-in-form';
import {
  answerFocusId,
  renderSignInFlow,
  type SignInActions,
} from './sign-in-flow.render';

setupRitewayBun();

const actions: SignInActions = {
  typeEmail: () => {},
  postLink: () => {},
  requestLink: () => true,
  signInWithPasskey: () => {},
  resend: () => {},
  changeEmail: () => {},
};

const asElement = (node: unknown) =>
  node as ReactElement<Readonly<Record<string, unknown>>>;

describe('renderSignInFlow', () => {
  test('renders the form for the email step, wired to the actions', () => {
    const element = asElement(
      renderSignInFlow(
        {
          step: 'enter-email',
          email: 'j@school.edu',
          pending: 'none',
          notice: 'rate-limited',
        },
        '',
        actions,
      ),
    );
    assert({
      given: 'the email step with a notice',
      should: 'pass the state and the actions to the form',
      actual: [
        element.type === SignInForm,
        element.props['email'],
        element.props['notice'],
        element.props['action'] === actions.postLink,
        element.props['requestLink'] === actions.requestLink,
        element.props['signInWithPasskey'] === actions.signInWithPasskey,
      ],
      expected: [true, 'j@school.edu', 'rate-limited', true, true, true],
    });
  });

  test('derives the countdown for the inbox step', () => {
    const element = asElement(
      renderSignInFlow(
        {
          step: 'check-inbox',
          email: 'j@school.edu',
          sentAt: '2026-09-21T12:00:00.000Z',
          resending: false,
        },
        '2026-09-21T12:00:18.000Z',
        actions,
      ),
    );
    assert({
      given: 'an inbox step 18 seconds after sending',
      should: 'show 42 seconds left and wire resend',
      actual: [
        element.type === CheckInbox,
        element.props['resendInMs'],
        element.props['resend'] === actions.resend,
      ],
      expected: [true, 42_000, true],
    });
  });

  test('never counts from before the latest send', () => {
    const element = asElement(
      renderSignInFlow(
        {
          step: 'check-inbox',
          email: 'j@school.edu',
          sentAt: '2026-09-21T12:05:00.000Z',
          resending: false,
        },
        '2026-09-21T12:00:18.000Z',
        actions,
      ),
    );
    assert({
      given: 'a tick older than a fresh send',
      should: 'cap the wait at the full cooldown',
      actual: element.props['resendInMs'],
      expected: 60_000,
    });
  });

  test('announces the signed-in step', () => {
    const node = renderSignInFlow({ step: 'signed-in' }, '', actions);
    assert({
      given: 'a successful sign-in',
      should: 'render a status while the page moves on',
      actual: [
        isValidElement(node),
        renderToString(node as ReactElement).includes('role="status"'),
      ],
      expected: [true, true],
    });
  });
});

describe('answerFocusId', () => {
  test('names where focus lands after a link answer, for each step', () => {
    const sentAt = '2026-09-24T12:00:00.000Z';
    assert({
      given:
        'a refused answer back on the email step, a sent one on the inbox step, and a signed-in page',
      should:
        'name the email field, then the inbox heading, then nothing (the page is leaving)',
      actual: [
        answerFocusId({
          step: 'enter-email',
          email: 'j@x.test',
          pending: 'none',
        }),
        answerFocusId({
          step: 'check-inbox',
          email: 'j@x.test',
          sentAt,
          resending: false,
        }),
        answerFocusId({ step: 'signed-in' }),
      ],
      expected: ['sign-in-email', 'check-inbox-heading', undefined],
    });
  });
});
