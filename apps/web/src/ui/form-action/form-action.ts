'use client';

import { useActionState, useEffect, useRef } from 'react';

/** A form's server action, as `useActionState` calls it. */
export type FormAction<S> = (state: Awaited<S>, form: FormData) => Promise<S>;

/**
 * `action`, answering `unavailable(form)` when the call itself fails. With
 * JavaScript on, a server action is a fetch the page makes; a dropped
 * connection rejects it before the action's own catch ever runs, and a
 * rejection inside `useActionState` replaces the page with the root error
 * screen (ISSUE-94).
 */
export const answerUnavailableOnThrow =
  <S>(
    action: FormAction<S>,
    unavailable: (form: FormData) => S,
  ): FormAction<S> =>
  async (state, form) => {
    try {
      return await action(state, form);
    } catch {
      return unavailable(form);
    }
  };

/**
 * `useActionState` for a form posting to a server action, whose call
 * answers `unavailable(form)` when it fails in transport. The server render
 * keeps the server action itself: React renders the form's no-JavaScript
 * POST, and adopts a posted form's answer, only from a server action, which
 * a wrapper is not. The browser only ever calls the wrapper.
 */
export function useFormAction<S>(
  action: FormAction<S>,
  initial: Awaited<S>,
  unavailable: (form: FormData) => S,
) {
  return useActionState(
    typeof window === 'undefined'
      ? action
      : answerUnavailableOnThrow(action, unavailable),
    initial,
  );
}

/**
 * Hands keyboard focus to the element `targetId` names once each new
 * answer has settled (ISSUE-107). A form disables its controls while its
 * answer is on the way, and a disabled control drops focus to <body>. The
 * answer the page was rendered with owes no focus. A new answer owes focus
 * until the state it leads to has rendered: while `settled` is false the
 * target is still the pre-answer screen's, which may be about to unmount,
 * so nothing is focused. Once settled, the target takes focus and the debt
 * is paid. With no target, nothing is owed.
 */
export function useFocusAfterAnswer(
  answered: unknown,
  targetId: string | undefined,
  settled: boolean,
) {
  const seen = useRef(answered);
  const owed = useRef(false);
  useEffect(() => {
    if (answered === seen.current) return;
    seen.current = answered;
    owed.current = true;
  }, [answered]);
  useEffect(() => {
    if (!owed.current || !settled) return;
    owed.current = false;
    if (targetId !== undefined) document.getElementById(targetId)?.focus();
  });
}
