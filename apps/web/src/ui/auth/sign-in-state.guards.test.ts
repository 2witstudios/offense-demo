import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  canRequestLink,
  canResend,
  formatCountdown,
  linkInFlight,
  RESEND_COOLDOWN_MS,
  resendRemainingMs,
} from './sign-in-state';
import { entering, inbox, iso } from './sign-in-state.test-support';

setupRitewayBun();

describe('guards', () => {
  test('canRequestLink', () => {
    assert({
      given: 'idle with an email, idle blank, pending, and the inbox step',
      should: 'allow only the idle step with an email',
      actual: [
        canRequestLink(entering()),
        canRequestLink(entering({ email: ' ' })),
        canRequestLink(entering({ pending: 'passkey' })),
        canRequestLink(inbox()),
      ],
      expected: [true, false, false, false],
    });
  });

  test('canResend', () => {
    assert({
      given: 'the inbox step during and after the cooldown',
      should: 'allow a resend only after it',
      actual: [
        canResend(inbox(), iso(2_000)),
        canResend(inbox(), iso(1_000 + RESEND_COOLDOWN_MS)),
        canResend(inbox({ resending: true }), iso(1_000 + RESEND_COOLDOWN_MS)),
        canResend(entering(), iso(1_000 + RESEND_COOLDOWN_MS)),
      ],
      expected: [false, true, false, false],
    });
  });

  test('linkInFlight', () => {
    assert({
      given:
        'a first send and a resend awaiting their answers, then idle, a passkey ceremony, a settled inbox, and a signed-in page',
      should:
        'report a link in flight only while a send or resend awaits its answer',
      actual: [
        linkInFlight(entering({ pending: 'link' })),
        linkInFlight(inbox({ resending: true })),
        linkInFlight(entering()),
        linkInFlight(entering({ pending: 'passkey' })),
        linkInFlight(inbox()),
        linkInFlight({ step: 'signed-in' }),
      ],
      expected: [true, true, false, false, false, false],
    });
  });
});

describe('resendRemainingMs', () => {
  test('counts down and never goes negative', () => {
    assert({
      given: 'times during and after the cooldown',
      should: 'return what is left, floored at zero',
      actual: [
        resendRemainingMs(iso(1_000), iso(1_000)),
        resendRemainingMs(iso(1_000), iso(19_000)),
        resendRemainingMs(iso(1_000), iso(1_000 + RESEND_COOLDOWN_MS + 5)),
      ],
      expected: [RESEND_COOLDOWN_MS, RESEND_COOLDOWN_MS - 18_000, 0],
    });
  });
});

describe('formatCountdown', () => {
  test('renders minutes and zero-padded seconds, rounding up', () => {
    assert({
      given: '42s, 41.2s, 60s, and 0',
      should: 'read like a clock and never show 0:00 early',
      actual: [
        formatCountdown(42_000),
        formatCountdown(41_200),
        formatCountdown(60_000),
        formatCountdown(0),
      ],
      expected: ['0:42', '0:42', '1:00', '0:00'],
    });
  });
});
