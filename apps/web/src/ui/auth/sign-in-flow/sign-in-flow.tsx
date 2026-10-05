'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Clock } from '@offense-demo/clock';
import { useFocusAfterAnswer } from '../../form-action/form-action';
import {
  offerPasskeyAutofillSafely,
  signInWithPasskeySafely,
  type PasskeyOutcome,
  type SignInPort,
} from '../sign-in-port';
import {
  canOfferPasskeyAutofill,
  canRequestLink,
  passkeyInFlight,
} from '../sign-in-state';
import { answerFocusId, renderSignInFlow } from './sign-in-flow.render';
import { useLinkRequest, type RequestLinkAction } from './use-link-request';
import { startPasskeyAutofill, type AutofillTimers } from './passkey-autofill';

const subscribeToVisibility = (onChange: () => void) => {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};

/**
 * Whether this tab is on screen. The server render and hydration report
 * hidden, so a tab opened in the background never arms autofill; a visible
 * one re-renders as visible right after hydration.
 */
const usePageVisible = (): boolean =>
  useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === 'visible',
    () => false,
  );

const browserTimers: AutofillTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type { RequestLinkAction };

export type SignInFlowProps = {
  /** Passkey ceremonies: the Better Auth adapter in the live page. */
  readonly port: SignInPort;
  /**
   * The email form's POST. A submission before hydration or without
   * JavaScript is the same POST, and the page renders its answer.
   */
  readonly requestLink: RequestLinkAction;
  /** Injected so the cooldown is testable and never reads ambient time. */
  readonly clock: Clock;
  /** Must keep the same identity across renders (useCallback). */
  readonly onSignedIn: () => void;
};

/**
 * Sign-in container: the reducer holds the state, the server action sends
 * links and the port runs passkey ceremonies. The first render starts from
 * the action's last answer, so a post made without JavaScript renders the
 * step it led to.
 */
export function SignInFlow({
  port,
  requestLink,
  clock,
  onSignedIn,
}: SignInFlowProps) {
  const { state, dispatch, now, postLink, resend, changeEmail } =
    useLinkRequest(requestLink, clock);
  // The passkey button is disabled while its ceremony runs, so its answer
  // owes focus the same way (ISSUE-118). Each settle is a new object.
  const [passkeyAnswer, setPasskeyAnswer] = useState<PasskeyOutcome>();
  useFocusAfterAnswer(
    passkeyAnswer,
    answerFocusId(state),
    !passkeyInFlight(state),
  );

  useEffect(() => {
    if (state.step === 'signed-in') onSignedIn();
  }, [state.step, onSignedIn]);

  // Armed whenever the email step goes idle on screen: the explicit passkey
  // button aborts the pending autofill request, so it is offered again after,
  // and a hidden tab pauses until it is shown.
  const autofillArmed = canOfferPasskeyAutofill(state, usePageVisible());
  useEffect(() => {
    if (!autofillArmed) return;
    return startPasskeyAutofill({
      offer: () => offerPasskeyAutofillSafely(port),
      onSettled: (outcome) => dispatch({ type: 'passkey-autofilled', outcome }),
      timers: browserTimers,
      now: () => Date.parse(clock.now()),
    });
  }, [autofillArmed, port, clock]);

  return renderSignInFlow(state, now, {
    typeEmail: (email) => dispatch({ type: 'email-typed', email }),
    postLink,
    requestLink: () => {
      if (!canRequestLink(state)) return false;
      dispatch({ type: 'link-requested' });
      return true;
    },
    signInWithPasskey: () => {
      if (state.step !== 'enter-email' || state.pending !== 'none') return;
      dispatch({ type: 'passkey-requested' });
      void signInWithPasskeySafely(port).then((outcome) => {
        dispatch({ type: 'passkey-settled', outcome });
        setPasskeyAnswer({ ...outcome });
      });
    },
    resend,
    changeEmail,
  });
}
