import {
  enrollmentNotices,
  type PasskeyEnrollment,
} from './passkey-enrollment';

export type PasskeyOfferState =
  | {
      readonly step: 'offer';
      /** The enrollment seam is running; the choices are locked. */
      readonly saving: boolean;
      /** Why the last attempt saved nothing; never a success. */
      readonly notice?: string;
    }
  | { readonly step: 'done' };

export type PasskeyOfferEvent =
  | { readonly type: 'enroll-started' }
  | { readonly type: 'enroll-settled'; readonly outcome: PasskeyEnrollment };

export const initialPasskeyOffer: PasskeyOfferState = {
  step: 'offer',
  saving: false,
};

/** Only a saved passkey finishes the offer; every other outcome says why. */
export function passkeyOfferReducer(
  state: PasskeyOfferState,
  event: PasskeyOfferEvent,
): PasskeyOfferState {
  if (state.step === 'done') return state;
  if (event.type === 'enroll-started')
    return state.saving ? state : { step: 'offer', saving: true };
  if (!state.saving) return state;
  if (event.outcome.kind === 'saved') return { step: 'done' };
  return {
    step: 'offer',
    saving: false,
    notice: enrollmentNotices[event.outcome.kind],
  };
}
