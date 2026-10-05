import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  createRequestLink,
  signInStateFrom,
  linkUnavailable,
  submitLinkRequest,
  type RequestLink,
} from './request-link';
import { initialSignInState } from './sign-in-state';
import {
  answering as recording,
  firstPost,
} from '../../lib/recorded-post.test-support';

setupRitewayBun();

const answering = (response: Response | Error) => {
  const { requests, send } = recording(response);
  return { requests, requestLink: createRequestLink(send, '/items') };
};

describe('createRequestLink', () => {
  test('asks for a link that lands on the destination, or on onboarding first', async () => {
    const { requests, requestLink } = answering(
      Response.json({ status: true }),
    );
    const outcome = await requestLink('ada@example.test');
    assert({
      given: 'an accepted request for a link',
      should: 'report sent, having posted the address and both callbacks',
      actual: { outcome, ...firstPost(requests) },
      expected: {
        outcome: { kind: 'sent' },
        url: '/api/auth/sign-in/magic-link',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: {
          email: 'ada@example.test',
          callbackURL: '/items',
          newUserCallbackURL: '/onboarding/username?next=%2Fitems',
        },
      },
    });
  });

  test('maps refusals to their honest outcomes', async () => {
    const outcome = async (response: Response | Error) =>
      (await answering(response).requestLink('a@b.test')).kind;
    assert({
      given:
        'suppressed, throttled, failing, invalid, unreadable and unreachable answers',
      should:
        'answer undeliverable, rate-limited, then unavailable for the rest',
      actual: [
        await outcome(
          Response.json({ code: 'EMAIL_UNDELIVERABLE' }, { status: 422 }),
        ),
        await outcome(new Response(null, { status: 429 })),
        await outcome(
          Response.json({ code: 'EMAIL_DELIVERY_FAILED' }, { status: 503 }),
        ),
        await outcome(Response.json({ code: 'VALIDATION' }, { status: 400 })),
        await outcome(new Response('not json', { status: 422 })),
        await outcome(new Error('network down')),
      ],
      expected: [
        'undeliverable',
        'rate-limited',
        'unavailable',
        'unavailable',
        'unavailable',
        'unavailable',
      ],
    });
  });
});

describe('submitLinkRequest', () => {
  const recording = (answer: ReturnType<RequestLink> | Error) => {
    const asked: string[] = [];
    const requestLink: RequestLink = async (email) => {
      asked.push(email);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { asked, requestLink };
  };

  test('requests the trimmed address and answers with it', async () => {
    const { asked, requestLink } = recording(Promise.resolve({ kind: 'sent' }));
    const form = new FormData();
    form.set('email', '  ada@example.test ');
    assert({
      given: 'a posted email form',
      should: 'request a link for the trimmed address and echo it back',
      actual: [await submitLinkRequest(requestLink, form), asked],
      expected: [
        { email: 'ada@example.test', outcome: { kind: 'sent' } },
        ['ada@example.test'],
      ],
    });
  });

  test('reads an untrusted form defensively', async () => {
    const { asked, requestLink } = recording(
      Promise.resolve({ kind: 'unavailable' }),
    );
    const form = new FormData();
    form.set('email', new Blob(['x']));
    assert({
      given: 'a form whose email field is a file',
      should: 'treat it as an empty address',
      actual: [(await submitLinkRequest(requestLink, form)).email, asked],
      expected: ['', ['']],
    });
  });

  test('a request that throws is unavailable, never sent', async () => {
    const { requestLink } = recording(new Error('handler blew up'));
    const form = new FormData();
    form.set('email', 'ada@example.test');
    assert({
      given: 'a link request that throws',
      should: 'answer unavailable',
      actual: await submitLinkRequest(requestLink, form),
      expected: { email: 'ada@example.test', outcome: { kind: 'unavailable' } },
    });
  });
});

describe('linkUnavailable', () => {
  test('answers unavailable for the posted address', () => {
    const typed = new FormData();
    typed.set('email', ' ada@example.test ');
    const file = new FormData();
    file.set('email', new Blob(['x']));
    assert({
      given: 'a posted form whose request never reached the server',
      should:
        'answer unavailable with the trimmed address, or an empty one for a file',
      actual: [linkUnavailable(typed), linkUnavailable(file)],
      expected: [
        { email: 'ada@example.test', outcome: { kind: 'unavailable' } },
        { email: '', outcome: { kind: 'unavailable' } },
      ],
    });
  });
});

describe('signInStateFrom', () => {
  test('starts where the last posted form ended', () => {
    const at = '2026-09-23T12:00:00.000Z';
    assert({
      given: 'no post yet, a sent link, and a refused request',
      should:
        'show the empty email step, the inbox step counting from now, and the email step with its notice',
      actual: [
        signInStateFrom({ email: '' }, at),
        signInStateFrom(
          { email: 'ada@school.edu', outcome: { kind: 'sent' } },
          at,
        ),
        signInStateFrom(
          { email: 'ada@school.edu', outcome: { kind: 'rate-limited' } },
          at,
        ),
      ],
      expected: [
        initialSignInState(),
        {
          step: 'check-inbox',
          email: 'ada@school.edu',
          sentAt: at,
          resending: false,
        },
        {
          step: 'enter-email',
          email: 'ada@school.edu',
          pending: 'none',
          notice: 'rate-limited',
        },
      ],
    });
  });
});
