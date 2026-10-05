import type { ReactNode } from 'react';
import { AuthFrame, AuthHeading, taglinePanel } from '../auth-frame/auth-frame';
import { CHECK_INBOX_HEADING_ID, CheckInbox } from '../check-inbox/check-inbox';
import { SIGN_IN_EMAIL_ID, SignInForm } from '../sign-in-form/sign-in-form';
import { resendRemainingMs, type SignInState } from '../sign-in-state';
import { appConfig } from '../../../app-config';

/** Actions the flow container binds to the server action, port and reducer. */
export type SignInActions = {
  readonly typeEmail: (email: string) => void;
  /** The email form's POST (a server action through `useActionState`). */
  readonly postLink: (form: FormData) => void;
  /** Marks the request in flight; false when the form must not post. */
  readonly requestLink: () => boolean;
  readonly signInWithPasskey: () => void;
  readonly resend: () => void;
  readonly changeEmail: () => void;
};

/**
 * A tick from before the latest send (or none yet) must not stretch the
 * countdown past the cooldown. UTC ISO strings compare in time order.
 */
const laterOf = (now: string, sentAt: string): string =>
  now > sentAt ? now : sentAt;

/**
 * Where keyboard focus lands once a link answer has rendered (ISSUE-107):
 * back on the email field when refused, on the inbox step's heading when
 * sent. A signed-in page is on its way out, so it takes no focus.
 */
export const answerFocusId = (state: SignInState): string | undefined => {
  switch (state.step) {
    case 'enter-email':
      return SIGN_IN_EMAIL_ID;
    case 'check-inbox':
      return CHECK_INBOX_HEADING_ID;
    case 'signed-in':
      return undefined;
  }
};

/** Pure: the screen for a state at a moment, wired to the given actions. */
export function renderSignInFlow(
  state: SignInState,
  /** UTC ISO, or '' before the first tick. */
  now: string,
  actions: SignInActions,
): ReactNode {
  switch (state.step) {
    case 'enter-email':
      return (
        <SignInForm
          email={state.email}
          pending={state.pending}
          notice={state.notice}
          typeEmail={actions.typeEmail}
          action={actions.postLink}
          requestLink={actions.requestLink}
          signInWithPasskey={actions.signInWithPasskey}
        />
      );
    case 'check-inbox':
      return (
        <CheckInbox
          email={state.email}
          resendInMs={resendRemainingMs(
            state.sentAt,
            laterOf(now, state.sentAt),
          )}
          resending={state.resending}
          resend={actions.resend}
          changeEmail={actions.changeEmail}
        />
      );
    case 'signed-in':
      return (
        <AuthFrame panel={taglinePanel}>
          <AuthHeading eyebrow="Signed in" title="You're in.">
            <span role="status">
              Taking you to {appConfig.brand.displayName}…
            </span>
          </AuthHeading>
        </AuthFrame>
      );
  }
}
