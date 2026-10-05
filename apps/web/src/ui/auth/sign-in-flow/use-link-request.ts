'use client';

import {
  startTransition,
  useEffect,
  useReducer,
  useState,
  type Dispatch,
} from 'react';
import type { Clock } from '@offense-demo/clock';
import {
  useFocusAfterAnswer,
  useFormAction,
} from '../../form-action/form-action';
import {
  initialLinkForm,
  linkUnavailable,
  signInStateFrom,
  type LinkFormState,
} from '../request-link';
import {
  canResend,
  linkInFlight,
  signInReducer,
  type SignInEvent,
  type SignInState,
} from '../sign-in-state';
import { answerFocusId } from './sign-in-flow.render';

/** The link request: a server action bound to the validated destination. */
export type RequestLinkAction = (
  state: LinkFormState,
  form: FormData,
) => Promise<LinkFormState>;

/**
 * Ticks once a second while a countdown is showing. It starts from the send
 * time, so the server and the first client render agree.
 */
function useNow(clock: Clock, state: SignInState): string {
  const ticking = state.step === 'check-inbox';
  const [now, setNow] = useState(() => (ticking ? state.sentAt : ''));
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(clock.now()), 1000);
    return () => clearInterval(timer);
  }, [clock, ticking]);
  return now;
}

export type LinkRequest = {
  readonly state: SignInState;
  readonly dispatch: Dispatch<SignInEvent>;
  /** UTC ISO, or '' before the first tick. */
  readonly now: string;
  /** The email form's POST (a server action through `useActionState`). */
  readonly postLink: (form: FormData) => void;
  readonly resend: () => void;
  readonly changeEmail: () => void;
};

/**
 * The email-link request every surface shares: the reducer holds the state,
 * the server action sends links, and the first render starts from the
 * action's last answer, so a post made without JavaScript renders the step
 * it led to. Each answer settles the request in flight, timed by this
 * browser's clock so the resend countdown never depends on the server's,
 * and hands focus to the step it leads to (ISSUE-107).
 */
export function useLinkRequest(
  requestLink: RequestLinkAction,
  clock: Clock,
): LinkRequest {
  const [answered, postLink] = useFormAction(
    requestLink,
    initialLinkForm,
    linkUnavailable,
  );
  const [state, dispatch] = useReducer(signInReducer, answered, (answer) =>
    signInStateFrom(answer, clock.now()),
  );
  const now = useNow(clock, state);

  // The answer a page was rendered with settles nothing: no request is in
  // flight then.
  useEffect(() => {
    if (answered.outcome === undefined) return;
    dispatch({
      type: 'link-settled',
      outcome: answered.outcome,
      at: clock.now(),
    });
  }, [answered, clock]);

  // Focus follows the state the answer settles into, one commit after the
  // answer itself: until then the screen is the pre-answer one.
  useFocusAfterAnswer(answered, answerFocusId(state), !linkInFlight(state));

  return {
    state,
    dispatch,
    now,
    postLink,
    resend: () => {
      const at = clock.now();
      if (!canResend(state, at) || state.step !== 'check-inbox') return;
      dispatch({ type: 'resend-requested', at });
      const form = new FormData();
      form.set('email', state.email);
      startTransition(() => postLink(form));
    },
    changeEmail: () => dispatch({ type: 'change-email' }),
  };
}
