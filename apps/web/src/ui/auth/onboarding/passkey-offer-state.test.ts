import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import {
  initialPasskeyOffer,
  passkeyOfferReducer,
  type PasskeyOfferEvent,
} from './passkey-offer-state';

setupRitewayBun();

const settle = (kind: 'saved' | 'cancelled' | 'failed' | 'unavailable') =>
  (
    [
      { type: 'enroll-started' },
      { type: 'enroll-settled', outcome: { kind } },
    ] as const satisfies readonly PasskeyOfferEvent[]
  ).reduce(passkeyOfferReducer, initialPasskeyOffer);

describe('passkeyOfferReducer', () => {
  test('locks while enrolling and never claims a save it did not make', () => {
    assert({
      given: 'enrollment started, then each seam outcome',
      should:
        'lock the choices, finish only on saved, and explain every other outcome',
      actual: [
        passkeyOfferReducer(initialPasskeyOffer, { type: 'enroll-started' }),
        settle('saved'),
        settle('unavailable'),
      ],
      expected: [
        { step: 'offer', saving: true },
        { step: 'done' },
        {
          step: 'offer',
          saving: false,
          notice:
            'Saving a passkey is not available yet, so nothing was saved. Email links keep working.',
        },
      ],
    });
  });

  test('a second start while saving changes nothing', () => {
    const saving = passkeyOfferReducer(initialPasskeyOffer, {
      type: 'enroll-started',
    });
    assert({
      given: 'an enrollment already running',
      should: 'keep the same state',
      actual: passkeyOfferReducer(saving, { type: 'enroll-started' }),
      expected: saving,
    });
  });

  test('a settle nobody started changes nothing', () => {
    assert({
      given: 'an enrollment result while not saving',
      should: 'ignore it',
      actual: passkeyOfferReducer(initialPasskeyOffer, {
        type: 'enroll-settled',
        outcome: { kind: 'saved' },
      }),
      expected: initialPasskeyOffer,
    });
  });
});
